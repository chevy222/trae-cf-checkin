/**
 * Trae Work 每日签到 —— Cloudflare Worker 单文件版（免 wrangler，控制台粘贴即用）
 * ------------------------------------------------------------------------
 * 入口：
 *   scheduled()  Cron 定时触发（控制台配置：每天一次，UTC 表达式见 README 对照表）
 *   fetch()      HTTP：/ 静态页(不执行任务) · /health · /logs · /log
 *                             /status · /run（公开，无需口令）
 *                             /login-url · /callback · /remove（需请求头 X-Admin-Token）
 * 存储：一个 KV Namespace，绑定名必须为 KV；一个密钥 ADMIN_TOKEN（仅 /login-url、/callback 用）
 * 对应 Python：trae_work_checkin.py（逻辑对齐：token 预刷新、status 免费先查、
 *   claim 单次、9074 退避状态写 KV 交下一个 Cron；云端不做进程内长睡眠）
 */

// ============================================================
// 常量（对齐 Python）
// ============================================================
const CLIENT_ID = "en1oxy7wnw8j9n";
const APP_VERSION = "0.1.43";
const PLUGIN_VERSION = "2.3.62834";

const AUTH_HOST = "https://api.trae.com.cn";   // 认证
const CREDITS_HOST = "https://api.trae.cn";     // 签到/积分
const LOGIN_PAGE = "https://www.trae.cn/authorization";

const REFRESH_AHEAD_SEC = 24 * 3600;        // 过期前 24h 预刷新
const MIN_CLAIM_INTERVAL_SEC = 30 * 60;     // 检查点最小间隔 30 分钟
const MAX_DAILY_ATTEMPTS = 20;              // 每日 claim 上限
const BACKOFF_PAUSE_MIN = [30, 60, 120, 240, 360]; // 9074 跨 Cron 退避档（分钟）

const LOCK_TTL = 90;                        // 乐观锁 TTL（秒）
const LOG_TTL = 30 * 24 * 3600;             // 日志保留 30 天
const LOG_LIST_LIMIT = 50;                  // /logs 列表条数

const JSON_H = { "Content-Type": "application/json;charset=utf-8" };
const HTML_H = { "Content-Type": "text/html;charset=utf-8", "X-Content-Type-Options": "nosniff" };
// 注意：Response 的头必须嵌在 init.headers 里；直接 new Response(html, HTML_H) 会被忽略并回退成 text/plain
const htmlRes = (html) => new Response(html, { headers: HTML_H });

// ============================================================
// 基础工具
// ============================================================
const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CST_OFFSET = 8 * 3600 * 1000; // UTC+8

// 把 epoch 秒转成北京时间字符串 / CST 日期
function fmtCST(ts) {
  if (!ts) return "-";
  return new Date(ts * 1000 + CST_OFFSET).toISOString().slice(0, 19).replace("T", " ");
}
function cstDay(ts) {
  return new Date(ts * 1000 + CST_OFFSET).toISOString().slice(0, 10);
}
function randHex(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function safeEqual(a, b) { // 恒定时间比较
  const enc = new TextEncoder();
  const x = enc.encode(a || ""), y = enc.encode(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// 每次运行的内存日志（同时 console.log 供控制台实时日志），结束整体落一条 KV
function makeLogger() {
  const lines = [];
  const push = (lvl, args) => {
    const msg = args.map((v) => (typeof v === "object" ? JSON.stringify(v) : String(v))).join(" ");
    lines.push(`[${fmtCST(nowSec())}] [${lvl}] ${msg}`);
    console.log(lvl, msg);
  };
  return {
    info: (...a) => push("INFO", a),
    warn: (...a) => push("WARN", a),
    error: (...a) => push("ERROR", a),
    debug: (...a) => push("DEBUG", a),
    text: () => lines.join("\n"),
  };
}

// ============================================================
// KV 助手
// ============================================================
const acctKey = (uid) => `acct:${uid}`;
const guardKey = (uid) => `guard:${uid}`;
const stateKey = (uid) => `state:${uid}`;
const lockKey = (uid) => `lock:${uid}`;

async function getJSON(kv, key, def) {
  try {
    const raw = await kv.get(key);
    return raw ? JSON.parse(raw) : def;
  } catch { return def; }
}
async function setJSON(kv, key, val, opts) {
  await kv.put(key, JSON.stringify(val), opts);
}

async function loadGuard(kv, uid) {
  const today = cstDay(nowSec());
  const def = { date: today, last_attempt: null, daily_attempts: 0, consecutive_rate_limits: 0, paused_until: null, last_success: null };
  const g = await getJSON(kv, guardKey(uid), null);
  const merged = g ? { ...def, ...g } : def;
  if (merged.date !== today) { // 跨天重置
    merged.date = today; merged.daily_attempts = 0;
    merged.consecutive_rate_limits = 0; merged.paused_until = null;
  }
  return merged;
}

// ============================================================
// HTTP（对齐 http_post：网络/5xx 重试，4xx 原样返回供判级）
// ============================================================
async function postJSON(url, body, headers = {}, retries = 3) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body || {}),
      });
      const text = await resp.text();
      if (resp.ok) {
        try { return text ? JSON.parse(text) : {}; } catch { return {}; }
      }
      if (resp.status >= 400 && resp.status < 500) return { _http_error: resp.status, _body: text };
      lastErr = new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
    } catch (e) { lastErr = e; }
    if (i < retries) await sleep(1000 * (i + 1));
  }
  throw lastErr;
}

// ============================================================
// 认证（对齐 build_login_url / parse_callback / ExchangeToken / GetUserInfo）
// ============================================================
function buildLoginUrl(machineId, deviceId) {
  const p = new URLSearchParams({
    login_version: "1", auth_from: "solo", login_channel: "native_ide",
    plugin_version: PLUGIN_VERSION, auth_type: "local", client_id: CLIENT_ID,
    redirect: "0", login_trace_id: randHex(8),
    auth_callback_url: "http://127.0.0.1:18080/authorize",
    machine_id: machineId, device_id: deviceId, x_device_id: deviceId, x_machine_id: machineId,
    x_device_brand: "PC", x_device_type: "PC", x_os_version: "1.0",
    x_app_version: APP_VERSION, x_app_type: "stable",
  });
  return `${LOGIN_PAGE}?${p.toString()}`;
}

function parseJsonParam(raw) {
  if (!raw) return {};
  let decoded = "";
  try { decoded = decodeURIComponent(raw); } catch { decoded = ""; }
  for (const v of [raw, decoded]) {
    try { const o = JSON.parse(v); if (o && typeof o === "object") return o; } catch {}
  }
  return {};
}
function parseCallbackUrl(callbackUrl) {
  const u = new URL(callbackUrl);
  const q = (n) => u.searchParams.get(n) || "";
  const userInfo = parseJsonParam(q("userInfo"));
  const userJwt = parseJsonParam(q("userJwt"));
  const refreshToken = q("refreshToken") || userJwt.RefreshToken || "";
  return {
    refresh_token: refreshToken,
    jwt_token: String(userJwt.Token || ""),
    uid: String(userInfo.UserID || ""),
    nickname: String(userInfo.ScreenName || ""),
    ent_id: String(userInfo.TenantID || ""),
    raw_jwt: q("userJwt"),
  };
}

class AuthError extends Error {}

async function exchangeToken(refreshToken) {
  const resp = await postJSON(
    AUTH_HOST + "/cloudide/api/v3/trae/oauth/ExchangeToken",
    { ClientID: CLIENT_ID, RefreshToken: refreshToken, ClientSecret: "-", UserID: "" },
    { "User-Agent": `Trae/${APP_VERSION}` },
  );
  if (resp._http_error) {
    const code = resp._http_error, body = (resp._body || "").toLowerCase();
    const authLike = code === 401 || code === 403 || ["invalid", "expired", "unauthorized", "forbidden"].some((k) => body.includes(k));
    throw authLike ? new AuthError(`ExchangeToken 鉴权失败 HTTP ${code}`) : new Error(`ExchangeToken 失败 HTTP ${code}`);
  }
  const result = resp.Result || {};
  const token = result.Token || "";
  if (!token) throw new AuthError("ExchangeToken 未返回 Token，登录态可能已失效");
  let expiresAt = parseInt(result.TokenExpireAt || 0, 10) || 0;
  if (expiresAt > 1e12) expiresAt = Math.floor(expiresAt / 1000); // 毫秒→秒
  if (expiresAt <= nowSec()) expiresAt = nowSec() + parseInt(result.TokenExpireDuration || 1209600, 10);
  return { access_token: token, refresh_token: result.RefreshToken || refreshToken, expires_at: expiresAt };
}

async function getUserInfo(accessToken) {
  try {
    const resp = await postJSON(
      AUTH_HOST + "/cloudide/api/v3/trae/GetUserInfo",
      { ReqSource: "IDE", IDEVersion: APP_VERSION },
      { "x-cloudide-token": accessToken, "User-Agent": `Trae/${APP_VERSION}` },
    );
    const r = resp.Result || resp;
    return { uid: String(r.UserID || ""), nickname: String(r.ScreenName || ""), enterprise_id: String(r.EnterpriseID || "") };
  } catch { return {}; }
}

// ============================================================
// 签到 / 积分
// ============================================================
function credHeaders(token, ahaDeviceId) { // claim 风控关键：x-device-id 必须 16 位 Aha 数字号
  return {
    Authorization: `Cloud-IDE-JWT ${token}`,
    "x-device-id": String(ahaDeviceId),
    "X-User-Region": "CN",
  };
}
const apiStatus = (t, d) => postJSON(CREDITS_HOST + "/trae/api/v2/ug/checkin_credits/status", {}, credHeaders(t, d));
const apiClaim = (t, d) => postJSON(CREDITS_HOST + "/trae/api/v2/ug/checkin_credits/claim", {}, credHeaders(t, d));

async function apiUsage(token, aha) {
  const resp = await postJSON(CREDITS_HOST + "/trae/api/v2/pay/ide_user_ent_usage", {}, credHeaders(token, aha));
  if (resp._http_error) return null;
  let limit = 0, used = 0;
  for (const p of resp.user_entitlement_pack_list || []) {
    const q = (p.entitlement_base_info || {}).quota || {};
    limit += q.credits_limit || 0;
    used += q.credits_amount || (p.usage || {}).credits_amount || 0;
  }
  return { limit, used, remaining: limit - used };
}

// ============================================================
// 录入凭证（/callback）：解析回调 → 换 token → 落 KV
// ============================================================
async function provision(env, body, logger) {
  const callbackUrl = body.callback_url || body.callbackUrl || "";
  const aha = String(body.aha_device_id || body.ahaDeviceId || "").trim();
  if (!callbackUrl) throw new Error("缺少 callback_url");
  if (!/^\d{8,16}$/.test(aha)) throw new Error("aha_device_id 必须是 8-16 位数字（实际应为 16 位 Aha 设备号）");

  const parsed = parseCallbackUrl(callbackUrl);
  let accessToken, refreshToken, expiresAt;
  if (parsed.refresh_token) {
    const tok = await exchangeToken(parsed.refresh_token);
    accessToken = tok.access_token; refreshToken = tok.refresh_token; expiresAt = tok.expires_at;
  } else if (parsed.jwt_token) { // 兜底：无 refreshToken，直接用 userJwt.Token
    accessToken = parsed.jwt_token; refreshToken = ""; expiresAt = 0;
    try {
      const j = parseJsonParam(parsed.raw_jwt);
      expiresAt = parseInt(j.TokenExpireAt || 0, 10) || 0;
      if (expiresAt > 1e12) expiresAt = Math.floor(expiresAt / 1000);
    } catch {}
    if (!expiresAt) expiresAt = nowSec() + 1209600;
  } else throw new Error("回调中没有 refreshToken 或 Token");

  const info = await getUserInfo(accessToken);
  const uid = info.uid || parsed.uid;
  if (!uid) throw new Error("未能获取 UID，Token 可能无效");
  const now = nowSec();
  const acct = {
    uid,
    nickname: info.nickname || parsed.nickname || "",
    enterprise_id: info.enterprise_id || parsed.ent_id || "",
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    machine_id: randHex(16),       // 仅 OAuth 过程使用
    oauth_device_id: randHex(16),  // 仅 OAuth 过程使用（claim 一律用 aha_device_id）
    aha_device_id: aha,
    created_at: now, updated_at: now,
  };
  await setJSON(env.KV, acctKey(uid), acct);
  if (!(await env.KV.get(guardKey(uid)))) await setJSON(env.KV, guardKey(uid), await loadGuard(env.KV, uid));
  logger.info("凭证已录入 UID", uid, "昵称", acct.nickname, "Aha", aha, "有效期至", fmtCST(expiresAt));
  return { uid, nickname: acct.nickname, aha_device_id: aha, expires_at: expiresAt, expires_at_str: fmtCST(expiresAt) };
}

// ============================================================
// 单账号一次运行（Cron / 手动共用；云端不睡眠，9074 交下一 Cron）
// ============================================================
async function runAccount(env, acct, { trigger, force, logger }) {
  const kv = env.KV, uid = acct.uid;

  // —— 乐观并发锁（KV 无 CAS，尽力而为，TTL 自动回收）——
  if (await kv.get(lockKey(uid))) {
    logger.warn("已有运行在途，跳过（并发保护）");
    return { ok: false, phase: "skipped", message: "并发跳过" };
  }
  await kv.put(lockKey(uid), JSON.stringify({ since: nowSec(), trigger }), { expirationTtl: LOCK_TTL });

  try {
    // —— 1) Token 预刷新 ——
    let cred = acct;
    const remaining = (cred.expires_at || 0) - nowSec();
    if (force || remaining <= REFRESH_AHEAD_SEC) {
      try {
        const tok = await exchangeToken(cred.refresh_token);
        cred = { ...cred, ...tok, updated_at: nowSec() };
        await setJSON(kv, acctKey(uid), cred);
        logger.info("Token 已刷新，有效期至", fmtCST(cred.expires_at));
      } catch (e) {
        if (e instanceof AuthError) throw e;
        if (remaining > 0) logger.warn("刷新失败，沿用旧 Token：", e.message);
        else throw new AuthError("Token 已过期且刷新失败：" + e.message);
      }
    } else {
      logger.info("Token 仍有效，剩余约", Math.floor(remaining / 3600), "小时");
    }

    const aha = String(cred.aha_device_id || "");
    if (!/^\d{8,16}$/.test(aha)) throw new Error("缺少合法 aha_device_id，请重新走 /callback 录入");

    // —— 2) 限频三道闸门（手动 force 时绕过）——
    const guard = await loadGuard(kv, uid);
    const now = nowSec();
    if (!force) {
      if (guard.paused_until && now < guard.paused_until)
        return { ok: false, phase: "skipped", message: `限频暂停至 ${fmtCST(guard.paused_until)}` };
      if (guard.last_attempt && now - guard.last_attempt < MIN_CLAIM_INTERVAL_SEC)
        return { ok: false, phase: "skipped", message: "距上次领取不足 30 分钟" };
      if ((guard.daily_attempts || 0) >= MAX_DAILY_ATTEMPTS)
        return { ok: false, phase: "skipped", message: "当日 claim 已达上限" };
    }

    // —— 3) 先免费查状态，已签即收手 ——
    logger.info("查询签到状态…");
    const status = await apiStatus(cred.access_token, aha);
    if (!status || status._http_error) return { ok: false, phase: "error", message: "签到状态查询失败" };
    if (status.checked_in) {
      guard.consecutive_rate_limits = 0; guard.paused_until = null;
      await setJSON(kv, guardKey(uid), guard);
      logger.info("今日已签到，当前签到积分", status.credits || 0);
      return { ok: true, phase: "already", message: "今日已签到", checked_in: true, credits: status.credits || 0 };
    }
    if (status.enable === false) return { ok: false, phase: "error", message: "签到功能未启用" };

    // —— 4) claim 恰好一次（不做进程内睡眠重试）——
    guard.last_attempt = now;
    guard.daily_attempts = (guard.daily_attempts || 0) + 1;
    logger.info("今日未签，发起领取（当日第", guard.daily_attempts, "次）");
    let result;
    try { result = await apiClaim(cred.access_token, aha); }
    catch (e) { // 网络层失败：回退计数，留给下一 Cron
      guard.daily_attempts = Math.max(0, guard.daily_attempts - 1);
      await setJSON(kv, guardKey(uid), guard);
      return { ok: false, phase: "error", message: "领取请求失败：" + e.message };
    }
    if (result._http_error) result = { code: result._http_error, message: `HTTP ${result._http_error}` };

    const code = result.code || 0;
    const msg = result.message || "";
    const low = msg.toLowerCase();

    if (code === 0 || !msg || low.includes("success") || low.includes("ok")) {
      guard.consecutive_rate_limits = 0; guard.paused_until = null; guard.last_success = now;
      await setJSON(kv, guardKey(uid), guard);
      logger.info("签到成功：", msg || "success");
      const usage = await apiUsage(cred.access_token, aha).catch(() => null);
      return { ok: true, phase: "claimed", message: msg || "签到成功", credits: result.credits || 0, usage };
    }
    if (low.includes("already") || msg.includes("已")) {
      guard.consecutive_rate_limits = 0; guard.paused_until = null;
      await setJSON(kv, guardKey(uid), guard);
      logger.info("今日已领取：", msg);
      return { ok: true, phase: "already", message: msg, checked_in: true };
    }
    if (code === 9074 || msg.includes("频繁") || msg.includes("太多") || low.includes("too frequent")) {
      const n = (guard.consecutive_rate_limits || 0) + 1;
      guard.consecutive_rate_limits = n;
      const pauseMin = BACKOFF_PAUSE_MIN[Math.min(n - 1, BACKOFF_PAUSE_MIN.length - 1)];
      guard.paused_until = now + pauseMin * 60;
      await setJSON(kv, guardKey(uid), guard);
      logger.warn(`触发限频(code=${code})，暂停 ${pauseMin} 分钟至 ${fmtCST(guard.paused_until)}，等下一个 Cron`);
      return { ok: false, phase: "rate_limited", message: msg || "服务器繁忙 9074", paused_min: pauseMin, resume_at: guard.paused_until };
    }
    await setJSON(kv, guardKey(uid), guard);
    logger.warn("其他业务返回 code=", code, "msg=", msg);
    return { ok: false, phase: "error", code, message: msg || `code ${code}` };
  } finally {
    await kv.delete(lockKey(uid)).catch(() => {});
  }
}

// 遍历所有账号；每个账号结束写 state + 一条 log
async function runAll(env, trigger, force) {
  const kv = env.KV;
  const list = await kv.list({ prefix: "acct:" });
  const out = [];
  for (const { name } of list.keys) {
    const acct = await getJSON(kv, name, null);
    if (!acct || !acct.uid) continue;
    const logger = makeLogger();
    const summary = { uid: acct.uid, nickname: acct.nickname || "", ok: false, phase: "error", message: "" };
    try {
      Object.assign(summary, await runAccount(env, acct, { trigger, force, logger }));
    } catch (e) {
      if (e instanceof AuthError) {
        summary.phase = "login_required";
        summary.message = "登录态失效，需重新走 /callback 录入";
      } else {
        summary.phase = "error";
        summary.message = String((e && e.message) || e);
      }
      logger.error(summary.message, e && e.message);
    } finally {
      const ts = nowSec();
      const tsMs = Date.now(); // 毫秒，避免同账号同秒多次运行覆盖日志
      await setJSON(kv, stateKey(acct.uid), { last_run_at: ts, trigger, ...summary });
      const logName = `log:${acct.uid}:${cstDay(ts).replace(/-/g, "")}:${tsMs}`;
      const body = `# ${acct.nickname || acct.uid}  ${fmtCST(ts)} (${trigger}${force ? ",manual" : ""})\n` +
        `结果：${summary.phase}  ${summary.message}\n\n${logger.text()}\n`;
      await kv.put(logName, body, {
        expirationTtl: LOG_TTL,
        metadata: { ts, uid: acct.uid, nick: acct.nickname || "", ok: !!summary.ok, phase: summary.phase, msg: String(summary.message || "").slice(0, 80) },
      });
      out.push(summary);
    }
  }
  return { ran_at: fmtCST(nowSec()), trigger, force, count: out.length, accounts: out };
}

// ============================================================
// /logs 日志页（公开、不含任何 token）
// ============================================================
const PHASE_LABEL = {
  claimed: ["成功", "#2F6B12", "rgba(82,196,26,.14)"],
  already: ["已签到", "#2F6B12", "rgba(82,196,26,.14)"],
  rate_limited: ["限频", "#8A5A12", "rgba(250,173,20,.16)"],
  skipped: ["跳过", "#5B6470", "rgba(0,0,0,.05)"],
  login_required: ["需重新登录", "#A33D3F", "rgba(234,102,104,.12)"],
  error: ["错误", "#A33D3F", "rgba(234,102,104,.12)"],
};
function badge(phase) {
  const [label, color, bg] = PHASE_LABEL[phase] || [phase || "-", "#5B6470", "rgba(0,0,0,.05)"];
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:12px;color:${color};background:${bg};">${escapeHtml(label)}</span>`;
}
function pageShell(title, inner) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="60">
<title>${escapeHtml(title)}</title></head>
<body style="margin:0;background:#F4F3EE;color:#1A1B1C;font-family:'PingFang SC','Segoe UI',Arial,sans-serif;line-height:1.6;">
<div style="max-width:860px;margin:0 auto;padding:20px 14px;">${inner}</div></body></html>`;
}
async function renderLogs(env, filterUid) {
  const kv = env.KV;
  const opts = { prefix: filterUid ? `log:${filterUid}:` : "log:", limit: LOG_LIST_LIMIT, reverse: true };
  const { keys } = await kv.list(opts);
  const rows = keys.map((k) => {
    const m = k.metadata || {};
    return `<tr>
      <td style="padding:8px 10px;white-space:nowrap;color:#6B7280;font-size:12px;">${escapeHtml(fmtCST(m.ts))}</td>
      <td style="padding:8px 10px;">${badge(m.phase)}</td>
      <td style="padding:8px 10px;font-size:13px;">${escapeHtml(m.nick || (m.uid ? "UID " + String(m.uid).slice(-4) : "-"))}</td>
      <td style="padding:8px 10px;font-size:13px;color:#374151;">${escapeHtml(m.msg || "")}</td>
      <td style="padding:8px 10px;"><a href="/log?id=${encodeURIComponent(k.name)}" style="color:#2E7E96;font-size:12px;text-decoration:none;">详情</a></td>
    </tr>`;
  }).join("");
  const inner = `
    <div style="display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;">
      <h2 style="font-size:17px;margin:0;">Trae 签到运行日志</h2>
      <span style="font-size:12px;color:#6B7280;">最近 ${LOG_LIST_LIMIT} 条 · 每 60 秒自动刷新 · 仅保留 30 天</span>
    </div>
    <hr style="border:none;border-top:1px solid #E4E3DD;margin:12px 0;">
    ${rows ? `<table style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #E4E3DD;border-radius:12px;overflow:hidden;">
      <thead><tr style="text-align:left;background:rgba(163,213,232,.18);font-size:12px;color:#374151;">
        <th style="padding:8px 10px;font-weight:600;">时间(北京)</th><th style="padding:8px 10px;font-weight:600;">结果</th>
        <th style="padding:8px 10px;font-weight:600;">账号</th><th style="padding:8px 10px;font-weight:600;">说明</th><th></th>
      </tr></thead><tbody>${rows}</tbody></table>`
      : `<div style="padding:18px;background:#fff;border:1px solid #E4E3DD;border-radius:12px;color:#6B7280;font-size:13px;">暂无运行记录（Cron 触发或 /run 后出现）。</div>`}`;
  return htmlRes(pageShell("签到日志", inner));
}

// ============================================================
// HTTP 路由
// ============================================================
function requireAdmin(req, env) {
  if (!env.ADMIN_TOKEN)
    return new Response(JSON.stringify({ error: "服务端未配置 ADMIN_TOKEN 密钥" }), { status: 500, headers: JSON_H });
  const got = req.headers.get("X-Admin-Token") || "";
  if (!safeEqual(got, env.ADMIN_TOKEN))
    return new Response(JSON.stringify({ error: "unauthorized：需要 X-Admin-Token 头" }), { status: 401, headers: JSON_H });
  return null;
}
async function readJson(req) { try { return await req.json(); } catch { return {}; } }

async function handleFetch(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // —— 根路径：纯静态说明，绝不执行任何任务 ——
  if (path === "/" && method === "GET") {
    const inner = `
      <h2 style="font-size:18px;">Trae 签到 Worker</h2>
      <p style="font-size:14px;color:#374151;">服务运行中。本页面<strong>不执行任何签到任务</strong>，任务只由 Cron 定时或 POST <code>/run</code> 触发。</p>
      <p style="font-size:14px;">
        <a href="/logs" style="color:#2E7E96;">运行日志 /logs</a>　·　
        <a href="/status" style="color:#2E7E96;">账号状态 /status</a>　·　
        <a href="/health" style="color:#2E7E96;">/health</a>
      </p>
      <p style="font-size:12px;color:#6B7280;">仅录入凭证用的 /login-url、/callback 需要请求头 X-Admin-Token；/run、/status、/logs 均公开。</p>`;
    return htmlRes(pageShell("Trae 签到 Worker", inner));
  }

  if (path === "/health" && method === "GET")
    return new Response(JSON.stringify({ ok: true, time: fmtCST(nowSec()) }), { headers: JSON_H });

  // —— 公开只读日志（无口令，内容已脱敏）——
  if (path === "/logs" && method === "GET")
    return renderLogs(env, url.searchParams.get("uid"));
  if (path === "/log" && method === "GET") {
    const id = url.searchParams.get("id") || "";
    if (!id.startsWith("log:")) return new Response("非法日志 id", { status: 400 }); // 白名单前缀，杜绝读到 acct:
    const text = (await env.KV.get(id)) || "记录不存在或已过期";
    const inner = `<p><a href="/logs" style="color:#2E7E96;font-size:13px;text-decoration:none;">← 返回列表</a></p>
      <pre style="white-space:pre-wrap;word-break:break-all;background:#fff;border:1px solid #E4E3DD;border-radius:12px;padding:14px;font-size:12.5px;line-height:1.6;">${escapeHtml(text)}</pre>`;
    return htmlRes(pageShell("日志详情", inner));
  }

  // —— 公开：账号状态（不含任何 token）——
  if (path === "/status" && method === "GET") {
    const { keys } = await env.KV.list({ prefix: "acct:" });
    const accounts = [];
    for (const { name } of keys) {
      const a = await getJSON(env.KV, name, null);
      if (!a) continue;
      const st = await getJSON(env.KV, stateKey(a.uid), {});
      accounts.push({
        uid: a.uid, nickname: a.nickname, aha_device_id: a.aha_device_id,
        token_expires: fmtCST(a.expires_at), state: st, // 不含任何 access/refresh token
      });
    }
    return new Response(JSON.stringify({ accounts }), { headers: JSON_H });
  }

  // —— 公开：手动触发（手动即强制，无参数）——
  if (path === "/run" && method === "POST") {
    const result = await runAll(env, "manual", true);
    return new Response(JSON.stringify(result), { headers: JSON_H });
  }

  // —— 录入/删除凭证的接口需要 X-Admin-Token ——
  if (path === "/login-url" || path === "/callback" || path === "/remove") {
    const deny = requireAdmin(req, env);
    if (deny) return deny;

    if (path === "/login-url" && method === "GET") {
      const machineId = randHex(16), deviceId = randHex(16);
      return new Response(JSON.stringify({
        login_url: buildLoginUrl(machineId, deviceId),
        machine_id: machineId, oauth_device_id: deviceId,
        hint: "浏览器打开 login_url 登录，复制跳到 127.0.0.1 的完整地址，连同 aha_device_id POST 到 /callback（需 X-Admin-Token 头）",
      }), { headers: JSON_H });
    }

    if (path === "/callback" && method === "POST") {
      const logger = makeLogger();
      try {
        const result = await provision(env, await readJson(req), logger);
        return new Response(JSON.stringify({ ok: true, ...result }), { headers: JSON_H });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e.message || e) }), { status: 400, headers: JSON_H });
      }
    }

    if (path === "/remove" && method === "POST") { // 删除账号：body {"uid":"数字"}，可选 keep_logs:true 保留历史日志
      const body = await readJson(req);
      const uid = String(body.uid || "").trim();
      if (!/^\d{4,32}$/.test(uid))
        return new Response(JSON.stringify({ ok: false, error: "参数 uid 必须为数字（先 GET /status 查看）" }), { status: 400, headers: JSON_H });
      if (!(await env.KV.get(acctKey(uid))))
        return new Response(JSON.stringify({ ok: false, error: "没有该账号，可能已被删除" }), { status: 404, headers: JSON_H });
      await env.KV.delete(acctKey(uid));   // 删它即停止签到（runAll 只遍历 acct:）
      await env.KV.delete(guardKey(uid));  // 限频状态
      await env.KV.delete(stateKey(uid));  // 最近运行快照
      let logsDeleted = 0;
      if (!body.keep_logs) {
        const { keys: logKeys } = await env.KV.list({ prefix: `log:${uid}:` });
        for (const k of logKeys) { await env.KV.delete(k.name); logsDeleted++; }
      }
      return new Response(JSON.stringify({ ok: true, uid, deleted: ["acct", "guard", "state"], logs_deleted: logsDeleted }), { headers: JSON_H });
    }

    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: JSON_H });
  }

  return new Response("Not Found", { status: 404 });
}

export default {
  async fetch(req, env) {
    try { return await handleFetch(req, env); }
    catch (e) {
      return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 500, headers: JSON_H });
    }
  },
  async scheduled(_controller, env) { // Cron：非强制，走完整闸门
    await runAll(env, "cron", false);
  },
};
