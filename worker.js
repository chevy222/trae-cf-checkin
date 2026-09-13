/**
 * Trae Work 每日签到 —— Cloudflare Worker 单文件版（免 wrangler，控制台粘贴即用）
 * ------------------------------------------------------------------------
 * 入口：
 *   scheduled()  Cron 定时触发（控制台配置：每天一次，UTC 表达式见 README 对照表）
 *   fetch()      HTTP：
 *     /          首页（账号 / 立即签到 / 运行日志 / 可用操作，不执行任务）
 *     /run       GET 公开，手动签到（与 Cron 同逻辑，受限频闸门保护）
 *     /status    GET 公开，账号与 Token 碰撞状态（浏览器=页面，程序调用=JSON）
 *     /logs      GET 公开，运行日志列表（60 秒自动刷新，行内可展开完整日志）
 *     /login-url、/callback、/remove、/refresh   仅需请求头 X-Admin-Token
 *   （已移除 /health 与 /log?id= 接口）
 * 存储：一个 KV Namespace，绑定名必须为 KV；一个密钥 ADMIN_TOKEN（仅 /login-url、/callback、/remove、/refresh 用）
 * 逻辑要点：token 预刷新、status 免费先查、claim 单次、
 *   9074 退避状态写 KV 交下一个 Cron；云端不做进程内长睡眠
 *
 * 本轮加固（不影响接口，纯内部行为）：
 *   1. claim 响应的 code 不再用 `|| 0` 兜底，避免空 body 被误判成「签到成功」
 *   2. 「已签到」判定收窄为明确措辞，避免含“已”字的错误消息被当成成功
 *   3. HTTP 429 纳入退避，与 9074 同等对待
 *   4. 所有上游请求加 15s 超时；5xx 响应体写入日志前先做凭据脱敏
 *   5. scheduled() 加兜底 try/catch，遍历前失败也会留一条日志
 *   6. /status 页与 JSON 增加限频闸门状态；回调参数改为不经 '+' → 空格 转换的解析
 *   7. scheduled() 入口补一行 console.log（实时日志不依赖 KV），并在 0 账号时也写一条日志，
 *      使「触发器没被调用」与「调用了但没配账号」在实时日志 / /logs 上可区分
 *   8. scheduled() 入口落一条 cron 心跳到 KV（cron:last，含 Cloudflare 实际使用的表达式与计划时间），
 *      并在首页与 /status 上展示（页面只显示上次触发时间；表达式与计划时间在 /status JSON 的 cron_last 字段里）
 *      ——「定时任务到底有没有来过」从此可持久查询，不必依赖当时是否有人看实时日志
 *   9. /logs 标注执行来源（定时触发 / 手动 · /run）：新日志写进 metadata.trigger，
 *      历史日志从正文首行的 (cron)/(manual) 兜底解析，页面与 JSON 都带上
 */

// ============================================================
// 页面展示的构建版本：日期（yyyymmdd）+ 当天第几次改动
// 当天第几个改动就写几；跨天则换成当天日期、序号从 1 重新开始。
// 页脚会显示它——配合自动部署时，刷新页面看这一行变没变，就知道新版本上线没有。
// ============================================================
const BUILD_VERSION = "20260913:2";

// ============================================================
// 常量（对齐 Python）
// ============================================================
const CLIENT_ID = "en1oxy7wnw8j9n";
const APP_VERSION = "0.1.43";
const PLUGIN_VERSION = "2.3.62834";

const AUTH_HOST = "https://api.trae.com.cn";   // 认证
const CREDITS_HOST = "https://api.trae.cn";     // 签到/积分
const LOGIN_PAGE = "https://www.trae.cn/authorization";

const REFRESH_AHEAD_SEC = 72 * 3600;        // 过期前 72h 预刷新（每天一次 Cron，提前 3 天兜住漏跑风险）
const MIN_CLAIM_INTERVAL_SEC = 30 * 60;     // 检查点最小间隔 30 分钟
const MAX_DAILY_ATTEMPTS = 20;              // 每日 claim 上限
const BACKOFF_PAUSE_MIN = [30, 60, 120, 240, 360]; // 9074 跨 Cron 退避档（分钟）

const LOCK_TTL = 90;                        // 乐观锁 TTL（秒）
const REQUEST_TIMEOUT_MS = 15000;           // 单次上游请求超时（毫秒），避免对端挂起拖死整个 Cron
const LOG_TTL = 30 * 24 * 3600;             // 日志保留 30 天
const LOG_LIST_LIMIT = 30;                  // /logs 列表条数（/logs 每 60 秒自动刷新，条数直接决定每次刷新读多少次 KV）

const JSON_H = {
  "Content-Type": "application/json;charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  // 这些接口返回的都是实时状态，缓存住会让人误判（如刷新页面看不到最新 version / 日志）
  "Cache-Control": "no-store",
};
const HTML_H = {
  "Content-Type": "text/html;charset=utf-8",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cache-Control": "no-store",
  // 页面无任何脚本 / 外链资源，只有内联样式，因此可以收得很死
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
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

// 兜底脱敏：上游 5xx 的响应体可能回显请求内容，而错误信息最终会写进 KV 日志，这里先抹掉疑似凭据
function redact(s) {
  return String(s == null ? "" : s)
    .replace(/eyJ[A-Za-z0-9_-]{10,}/g, "«jwt»")
    .replace(/(["']?(?:access_token|refresh_token|token|authorization)["']?\s*[:=]\s*["']?)([^"',\s}]{6,})/gi, "$1«redacted»");
}

// 每次运行的内存日志（同时 console.log 供控制台实时日志），结束整体落一条 KV
function makeLogger() {
  const lines = [];
  const stringify = (v) => { // 循环引用 / BigInt 会让 JSON.stringify 抛异常，不能让日志拖垮主流程
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  const push = (lvl, args) => {
    const msg = args.map((v) => (v && typeof v === "object" ? stringify(v) : String(v))).join(" ");
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
// Cron 心跳：只由 scheduled() 写、与账号无关。key 前缀不是 acct:，不会被 runAll 当成账号遍历到。
// 用途：证明「定时任务真的被调度到过」，并把 Cloudflare 实际使用的表达式记下来供核对。
const CRON_KEY = "cron:last";

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
  const def = { date: today, last_attempt: null, daily_attempts: 0, consecutive_rate_limits: 0, paused_until: null };
  const g = await getJSON(kv, guardKey(uid), null);
  // 只挑已知字段，不用 { ...def, ...g } 整体合并：早期版本写过 last_success，
  // 现在已不再维护，整体合并会把它一并带出来、显示在 /status 上，
  // 看起来像"最近一次成功时间"，实则早已冻结，会误导判断。
  const merged = { ...def };
  if (g) for (const k of Object.keys(def)) if (g[k] !== undefined) merged[k] = g[k];
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
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), // 无超时会让对端挂起拖死整个 Cron
      });
      const text = await resp.text();
      if (resp.ok) {
        try { return text ? JSON.parse(text) : {}; } catch { return {}; }
      }
      if (resp.status >= 400 && resp.status < 500) return { _http_error: resp.status, _body: text };
      lastErr = new Error(`HTTP ${resp.status}${text ? `: ${redact(text).slice(0, 200)}` : ""}`);
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
// 从原始查询串取参数：只做一次 %XX 解码，不做 x-www-form-urlencoded 的 '+' → 空格转换。
// searchParams.get() 会把字面量 '+' 解成空格，refreshToken / userJwt 里若含 '+' 会被悄悄破坏。
function rawParam(rawQuery, name) {
  const m = rawQuery.match(new RegExp(`(?:^|&)${name}=([^&]*)`));
  if (!m) return "";
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}
function parseCallbackUrl(callbackUrl) {
  const u = new URL(callbackUrl);
  const rawQuery = (u.search || u.hash || "").replace(/^[?#]/, "");
  const q = (n) => rawParam(rawQuery, n);
  const userInfo = parseJsonParam(q("userInfo"));
  const userJwt = parseJsonParam(q("userJwt"));
  const refreshToken = q("refreshToken") || userJwt.RefreshToken || "";
  return {
    refresh_token: refreshToken,
    jwt_token: String(userJwt.Token || ""),
    uid: String(userInfo.UserID || ""),
    nickname: String(userInfo.ScreenName || ""),
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
    return { uid: String(r.UserID || ""), nickname: String(r.ScreenName || "") };
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
    const j = parseJsonParam(parsed.raw_jwt); // 内部已吞异常，无需再包 try/catch
    expiresAt = parseInt(j.TokenExpireAt || 0, 10) || 0;
    if (expiresAt > 1e12) expiresAt = Math.floor(expiresAt / 1000);
    if (!expiresAt) expiresAt = nowSec() + 1209600;
  } else throw new Error("回调中没有 refreshToken 或 Token");

  const info = await getUserInfo(accessToken);
  const uid = info.uid || parsed.uid;
  if (!uid) throw new Error("未能获取 UID，Token 可能无效");
  const now = nowSec();
  const acct = {
    uid,
    nickname: info.nickname || parsed.nickname || "",
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    aha_device_id: aha,
    created_at: now, updated_at: now,
  };
  await setJSON(env.KV, acctKey(uid), acct); // guard 键无需预写：loadGuard 自带默认值与跨天重置，首次运行时自动落盘
  logger.info("凭证已录入 UID", uid, "昵称", acct.nickname, "Aha", aha, "有效期至", fmtCST(expiresAt));
  return { uid, nickname: acct.nickname, aha_device_id: aha, expires_at: expiresAt, expires_at_str: fmtCST(expiresAt) };
}

// ============================================================
// 手动刷新全部账号 Token（/refresh，需 X-Admin-Token；不受 72h 阈值限制，强制换新）
// ============================================================
async function refreshAllTokens(env) {
  const kv = env.KV;
  const { keys } = await kv.list({ prefix: "acct:" });
  const out = [];
  for (const { name } of keys) {
    const acct = await getJSON(kv, name, null);
    if (!acct || !acct.uid) continue;
    const summary = { uid: acct.uid, nickname: acct.nickname || "", refreshed: false, message: "" };
    // 与签到共用同一把锁：exchangeToken 会轮换 refresh_token，
    // 手动刷新与 Cron 签到并发时两边同用旧 refresh_token，可能互相把对方刷失效
    if (await kv.get(lockKey(acct.uid))) {
      summary.message = "已有运行在途，跳过（并发保护），稍后重试";
      out.push(summary);
      continue;
    }
    await kv.put(lockKey(acct.uid), JSON.stringify({ since: nowSec(), trigger: "refresh" }), { expirationTtl: LOCK_TTL });
    try {
      if (!acct.refresh_token) throw new Error("该账号无 refresh_token（历史兜底方式录入），需重新走 /callback 录入");
      const tok = await exchangeToken(acct.refresh_token);
      const updated = { ...acct, ...tok, updated_at: nowSec() };
      await setJSON(kv, acctKey(acct.uid), updated);
      summary.refreshed = true;
      summary.message = `已刷新，有效期至 ${fmtCST(updated.expires_at)}`;
      console.log("[refresh] UID", acct.uid, summary.message);
    } catch (e) {
      summary.message = (e instanceof AuthError ? "登录态已失效，需重新走 /callback 录入：" : "刷新失败：") + String((e && e.message) || e);
    } finally {
      await kv.delete(lockKey(acct.uid)).catch(() => {});
    }
    out.push(summary);
  }
  return { ran_at: fmtCST(nowSec()), count: out.length, accounts: out };
}

// ============================================================
// 单账号一次运行（Cron / 手动共用；云端不睡眠，9074 交下一 Cron）
// ============================================================
async function runAccount(env, acct, { trigger, logger }) {
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
    if (remaining <= REFRESH_AHEAD_SEC) {
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

    // —— 2) 限频三道闸门 ——
    const guard = await loadGuard(kv, uid);
    const now = nowSec();
    if (guard.paused_until && now < guard.paused_until)
      return { ok: false, phase: "skipped", message: `限频暂停至 ${fmtCST(guard.paused_until)}` };
    if (guard.last_attempt && now - guard.last_attempt < MIN_CLAIM_INTERVAL_SEC)
      return { ok: false, phase: "skipped", message: "距上次领取不足 30 分钟" };
    if ((guard.daily_attempts || 0) >= MAX_DAILY_ATTEMPTS)
      return { ok: false, phase: "skipped", message: "当日 claim 已达上限" };

    // —— 3) 先免费查状态，已签即收手 ——
    logger.info("查询签到状态…");
    const status = await apiStatus(cred.access_token, aha);
    if (status && (status._http_error === 401 || status._http_error === 403))
      throw new AuthError(`签到状态查询返回 HTTP ${status._http_error}，登录态已失效，需重新走 /callback 录入`);
    if (!status || status._http_error)
      return { ok: false, phase: "error", message: `签到状态查询失败（HTTP ${status ? status._http_error : "网络异常"}）` };
    if (status.checked_in) {
      guard.consecutive_rate_limits = 0; guard.paused_until = null;
      await setJSON(kv, guardKey(uid), guard);
      const message = (status.credits != null && status.credits !== "")
        ? `今日已签到，当前签到积分 ${status.credits}` : "今日已签到";
      logger.info(message);
      return { ok: true, phase: "already", message, checked_in: true, credits: status.credits || 0 };
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
    if (result._http_error === 401 || result._http_error === 403) {
      await setJSON(kv, guardKey(uid), guard); // 先落 attempt 计数，再按登录失效上抛
      throw new AuthError(`领取接口返回 HTTP ${result._http_error}，登录态已失效，需重新走 /callback 录入`);
    }
    if (result._http_error) result = {
      code: result._http_error,
      // 429 是标准限频码，给个可读消息，后面会走退避分支
      message: result._http_error === 429 ? "HTTP 429 请求过于频繁" : `HTTP ${result._http_error}`,
    };

    // 注意：不能写 result.code || 0。上游 HTTP 200 但 body 为空时 postJSON 返回 {}，
    // undefined 会被折成 0，从而被下面的 code === 0 误判为「签到成功」，还顺手清掉限频暂停状态。
    const hasCode = result.code !== undefined && result.code !== null;
    const code = hasCode ? Number(result.code) : null;
    const msg = result.message || "";
    const low = msg.toLowerCase();

    if (!hasCode && !msg) { // 既无 code 也无 message：响应结构不可识别，按失败处理并留证
      await setJSON(kv, guardKey(uid), guard); // 保留本次 attempt 计数，留给下一周期
      logger.warn("签到响应结构异常，原始返回：", JSON.stringify(result).slice(0, 300));
      return { ok: false, phase: "error", code: null, message: "签到响应结构异常（未返回 code/message），已按失败处理" };
    }

    if (code === 0 || low.includes("success")) {
      guard.consecutive_rate_limits = 0; guard.paused_until = null;
      await setJSON(kv, guardKey(uid), guard);
      // 本次新增积分：优先取 claim 返回的 credits；没有则再查一次免费 status，
      // 用领取前后的签到积分差值算出（领取前数值缺失时只展示当前值，不算差值以免虚报）
      let gained = Number(result.credits) || 0;
      let curCredits = null;
      if (!gained) {
        const after = await apiStatus(cred.access_token, aha).catch(() => null);
        if (after && !after._http_error) {
          const pre = Number(status.credits), post = Number(after.credits);
          if (Number.isFinite(post)) {
            curCredits = post;
            if (Number.isFinite(pre)) gained = Math.max(0, post - pre);
          }
        }
      }
      const message = gained > 0
        ? `签到成功，本次 +${gained} 积分`
        : (curCredits != null ? `签到成功，当前签到积分 ${curCredits}` : `签到成功（${msg || "success"}）`);
      logger.info(message);
      const usage = await apiUsage(cred.access_token, aha).catch(() => null);
      return { ok: true, phase: "claimed", message, credits: gained, usage };
    }
    // 只用「已签到 / 已领取」等明确措辞：原来的 msg.includes("已") 会把
    // “请求已过期”“账号已在其他设备登录”之类错误也判成已签到并返回 ok:true
    if (low.includes("already") || /已(签到|领取|领过|签过)/.test(msg)) {
      guard.consecutive_rate_limits = 0; guard.paused_until = null;
      await setJSON(kv, guardKey(uid), guard);
      logger.info("今日已领取：", msg);
      return { ok: true, phase: "already", message: msg, checked_in: true };
    }
    if (code === 9074 || code === 429 || msg.includes("频繁") || msg.includes("太多") || low.includes("too frequent")) {
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
async function runAll(env, trigger) {
  const kv = env.KV;
  const list = await kv.list({ prefix: "acct:" });
  const out = [];
  for (const { name } of list.keys) {
    const acct = await getJSON(kv, name, null);
    if (!acct || !acct.uid) continue;
    const logger = makeLogger();
    const summary = { uid: acct.uid, nickname: acct.nickname || "", ok: false, phase: "error", message: "" };
    try {
      Object.assign(summary, await runAccount(env, acct, { trigger, logger }));
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
      const logName = `log:${tsMs}:${acct.uid}`; // 时间戳在前：KV 键序即全局时间序
      const body = `# ${acct.nickname || acct.uid}  ${fmtCST(ts)} (${trigger})\n` +
        `结果：${summary.phase}  ${summary.message}\n\n${logger.text()}\n`;
      await kv.put(logName, body, {
        expirationTtl: LOG_TTL,
        metadata: { ts, uid: acct.uid, nick: acct.nickname || "", ok: !!summary.ok, phase: summary.phase, trigger, msg: String(summary.message || "").slice(0, 80) },
      });
      out.push(summary);
    }
  }
  return { ran_at: fmtCST(nowSec()), trigger, count: out.length, accounts: out };
}

// ============================================================
// 页面（与 WorkBuddy 版同风格的统一样式）
// ============================================================
const PAGE_CSS = `
*{box-sizing:border-box;}
body{margin:0;background:#F4F3EE;color:#1A1B1C;font-family:'PingFang SC','Segoe UI','Microsoft YaHei',Arial,sans-serif;line-height:1.6;font-size:13.5px;}
.wrap{max-width:920px;margin:0 auto;padding:20px 14px 40px;}
.hd{display:flex;justify-content:space-between;align-items:baseline;flex-wrap:wrap;gap:8px;}
h2{font-size:17px;margin:0;font-weight:600;}
h3{font-size:14px;margin:16px 0 6px;}
.sub{font-size:12px;color:#6B7280;}
hr{border:none;border-top:1px solid #E4E3DD;margin:12px 0;}
a{color:#2E7E96;text-decoration:none;} a:hover{text-decoration:underline;}
code{background:rgba(46,126,150,.08);border:1px solid rgba(46,126,150,.18);border-radius:4px;padding:0 4px;font-size:12px;}
.tbl-scroll{overflow-x:auto;}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #E4E3DD;border-radius:12px;overflow:hidden;}
th{text-align:left;background:rgba(163,213,232,.18);font-size:12px;color:#374151;padding:8px 10px;font-weight:600;white-space:nowrap;}
td{padding:8px 10px;font-size:13px;border-top:1px solid #F0EFEA;vertical-align:top;}
.badge{display:inline-block;padding:2px 9px;border-radius:10px;font-size:12px;white-space:nowrap;}
.card{background:#fff;border:1px solid #E4E3DD;border-radius:12px;padding:12px 14px;margin:10px 0;}
.cardhd{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:4px;}
.accname{font-weight:600;font-size:14px;}
.report{font-size:13.5px;color:#1F2937;word-break:break-word;}
.meta{font-size:12px;color:#6B7280;margin-top:5px;word-break:break-word;}
pre{white-space:pre-wrap;word-break:break-all;background:#fff;border:1px solid #E4E3DD;border-radius:12px;padding:14px;font-size:12.5px;line-height:1.6;}
details{margin-top:8px;} summary{cursor:pointer;color:#6B7280;font-size:12.5px;}
.btnrow a{display:inline-block;padding:6px 14px;border:1px solid #CFDADF;background:#fff;border-radius:999px;font-size:13px;margin:0 8px 8px 0;}
.warn{border-color:rgba(234,102,104,.45);}
/* 移动端：日志表格转卡片布局（<640px 时每行一张卡，td 前置列名标签） */
@media (max-width:640px){
  .tbl-scroll{overflow-x:visible;}
  .logtbl{display:block;border:none;background:transparent;}
  .logtbl thead{display:none;}
  .logtbl tbody{display:block;}
  .logtbl tr{display:block;background:#fff;border:1px solid #E4E3DD;border-radius:12px;margin:10px 0;}
  .logtbl td{display:block;border-top:none;padding:5px 14px;}
  .logtbl td + td{border-top:1px dashed #F0EFEA;}
  .logtbl td[data-label]::before{content:attr(data-label);display:inline-block;min-width:4.5em;color:#6B7280;font-size:12px;}
}
`;

function pageShell(title, inner, autoRefresh) {
  return "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\">" +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    (autoRefresh ? '<meta http-equiv="refresh" content="60">' : "") +
    "<title>" + escapeHtml(title) + "</title><style>" + PAGE_CSS + "</style></head>" +
    '<body><div class="wrap">' + inner +
    '<footer style="text-align:center;margin-top:18px;font-size:12px;color:#8A919C;">Powered by <a href="https://github.com/chevy222/trae-cf-checkin" target="_blank" rel="noopener">Github</a><br><span style="color:#A8AEB8;">version ' + escapeHtml(BUILD_VERSION) + '</span></footer>' +
    '</div></body></html>';
}

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
  return `<span class="badge" style="color:${color};background:${bg};">${escapeHtml(label)}</span>`;
}

// 执行来源的中文标签（与 workbuddy 版同款）：cron=定时触发，manual=手动访问 /run
function triggerLabel(t) {
  if (!t) return "-";
  if (t === "cron") return "定时触发";
  if (t === "manual") return "手动 · /run";
  if (t.indexOf("http:") === 0) return "手动 · " + t.slice(5); // 兼容 workbuddy 风格的取值
  return String(t);
}

// 工具条：首页 / 立即签到 / 运行日志 / 账号状态
function toolbar() {
  return `<div class="btnrow" style="margin-top:4px;">` +
    `<a href="/run">▶ 立即签到</a>` +
    `<a href="/logs">运行日志</a>` +
    `<a href="/status">账号状态</a>` +
    `<a href="/">首页</a>` +
    `</div>`;
}

/* —— 定时任务心跳卡：一眼看出「cron 到底有没有来过」，不依赖账号是否配置、也不依赖当时是否在看实时日志。
   卡片只显示上次触发时间；Cloudflare 实际使用的表达式与计划时间仍在 /status JSON 的 cron_last 字段里，需要核对时程序调用查询 —— */
function cronCard(hb) {
  return hb
    ? `<div class="card"><div class="accname">定时任务（Cron）</div>` +
      `<div class="report" style="color:#2F6B12;">上次触发：${escapeHtml(fmtCST(hb.ts))}</div></div>`
    : `<div class="card warn"><div class="accname">定时任务（Cron）</div>` +
      `<div class="report" style="color:#B03A3C;">尚无触发记录</div>` +
      `<div class="meta">若面板上已配置 Cron 触发器、此卡却长期为空，说明定时任务没有被调度到（代码侧无法影响调度，需查触发器配置与域名绑定的 Worker）。</div></div>`;
}

/* —— 首页：定时任务心跳 + 账号 + 立即签到 + 运行日志 + 可用操作（与 WorkBuddy 首页一致） —— */
async function renderHome(env) {
  const cronBlock = cronCard(await getJSON(env.KV, CRON_KEY, null));
  let accBlock;
  try {
    const { keys } = await env.KV.list({ prefix: "acct:" });
    const accounts = [];
    for (const { name } of keys) {
      const a = await getJSON(env.KV, name, null);
      if (a && a.uid) accounts.push(a);
    }
    if (accounts.length) {
      const lines = accounts.map((a) => {
        const nm = a.nickname || (a.uid ? "UID " + String(a.uid).slice(-4) : "未命名");
        const left = Math.floor(((a.expires_at || 0) - nowSec()) / 86400);
        let t = escapeHtml(nm);
        if (a.expires_at) {
          // 与 WorkBuddy 版统一：只显示日期（精确到秒的到期时刻对用户没有可操作性）
          if (left < 0) t += `，<span style="color:#B03A3C;">令牌已过期（${cstDay(a.expires_at)}）</span>`;
          else if (left <= 7) t += `，<span style="color:#B03A3C;">令牌剩 ${left} 天（${cstDay(a.expires_at)} 到期）</span>`;
          else t += `，令牌剩 ${left} 天（${cstDay(a.expires_at)} 到期）`;
        }
        return t;
      });
      accBlock = '<div class="card">已配置 <b>' + accounts.length + "</b> 个账号：<br>" + lines.join("<br>") + "</div>";
    } else {
      accBlock = '<div class="card">当前配置 <b>0</b> 个账号。通过 <code>/login-url</code> 生成登录链接、<code>/callback</code> 录入（需 <code>X-Admin-Token</code>）后即可开始签到。</div>';
    }
  } catch (e) {
    accBlock = '<div class="card warn" style="color:#B03A3C;">' + escapeHtml(String(e.message || e)) + "</div>";
  }

  const rows = [
    ["<a href=\"/run\">/run</a>", "立即签到（GET，逻辑与 Cron 相同，受限频闸门保护）"],
    ["<a href=\"/status\">/status</a>", "查看账号与 Token 到期 / 最近一次运行状态"],
    ["<a href=\"/logs\">/logs</a>", "最近 " + LOG_LIST_LIMIT + " 次运行日志（60 秒自动刷新，可展开详情）"],
    ["/login-url", "生成 Trae 登录链接（GET，需 X-Admin-Token）"],
    ["/refresh", "手动刷新所有账号 Token（GET，需 X-Admin-Token，强制换新不受 72 小时阈值限制）"],
    ["/callback", "录入 / 更新凭证（POST，需 X-Admin-Token，JSON 见 README）"],
    ["/remove", "删除某账号及其日志（POST，需 X-Admin-Token）"],
  ].map(([path, desc]) =>
    "<tr><td style=\"white-space:nowrap;\">" + path + "</td><td class=\"sub\">" + desc + "</td></tr>"
  ).join("");

  const inner =
    '<div class="hd"><h2>Trae 签到 Worker</h2><span class="sub">云端自动签到 · Token 自动续期 · 幂等可重复执行</span></div>' +
    cronBlock +
    accBlock +
    '<div class="btnrow" style="margin-top:6px;"><a href="/run">▶ 立即签到</a><a href="/logs">运行日志</a></div>' +
    '<h3>可用操作</h3><div class="tbl-scroll"><table><tbody>' + rows + "</tbody></table></div>" +
    '<p class="sub" style="margin-top:12px;">提示：<code>/run</code>、<code>/status</code>、<code>/logs</code> 公开、浏览器可直接打开；录入/删除凭证与手动刷新 Token 的 <code>/login-url</code>、<code>/callback</code>、<code>/remove</code>、<code>/refresh</code> 需请求头 <code>X-Admin-Token</code>。程序调用时返回 JSON。</p>';
  return htmlRes(pageShell("Trae 签到 Worker", inner, false));
}

/* —— /status：账号与 Token 状态页 —— */
async function renderStatus(env) {
  const { keys } = await env.KV.list({ prefix: "acct:" });
  const hb = await getJSON(env.KV, CRON_KEY, null);
  const cards = [];
  let any = false;
  for (const { name } of keys) {
    const a = await getJSON(env.KV, name, null);
    if (!a || !a.uid) continue;
    any = true;
    const st = await getJSON(env.KV, stateKey(a.uid), {});
    const guard = await loadGuard(env.KV, a.uid);
    const nm = a.nickname || (a.uid ? "UID " + String(a.uid).slice(-4) : "未命名");
    const left = Math.floor(((a.expires_at || 0) - nowSec()) / 86400);
    const expireMiddle = !a.expires_at ? "-"
      : (left < 0 ? `<span style="color:#B03A3C;">已过期</span>` : "剩 " + left + " 天");
    const expireTail = a.expires_at ? " · " + cstDay(a.expires_at) : ""; // 只到日期，完整时间戳在下方原始 JSON 里
    // 逐字段转义后拼接（不要先拼好 HTML 再整体 escapeHtml——那样会把上面的 <span> 转成字面文本）。
    // expireMiddle / expireTail 之外的片段都可能含 KV 里的数据，这里统一 escapeHtml 兜住。
    const meta = [
      escapeHtml("UID " + String(a.uid).replace(/(\d{4})\d+(\d{4})/, "$1••••$2")),
      escapeHtml("设备号 " + String(a.aha_device_id || "-").replace(/(\d{4})\d+(\d{4})/, "$1••••••••$2")),
      "Token 到期：" + expireMiddle + escapeHtml(expireTail),
      escapeHtml("上次运行：" + (st.last_run_at ? fmtCST(st.last_run_at) + " · " + triggerLabel(st.trigger) : "暂无")),
    ];
    // 限频闸门状态：把「为什么这次是 skipped」直接摊开，不用去猜
    const now = nowSec();
    const gate = [`今日 claim ${guard.daily_attempts || 0}/${MAX_DAILY_ATTEMPTS} 次`];
    if (guard.paused_until && now < guard.paused_until) gate.push(`限频暂停至 ${fmtCST(guard.paused_until)}`);
    if (guard.consecutive_rate_limits) gate.push(`连续限频 ${guard.consecutive_rate_limits} 次`);
    if (guard.last_attempt) {
      const wait = MIN_CLAIM_INTERVAL_SEC - (now - guard.last_attempt);
      gate.push(wait > 0 ? `距可领取还有 ${Math.ceil(wait / 60)} 分钟` : `上次领取尝试 ${fmtCST(guard.last_attempt)}`);
    }
    cards.push(`<div class="card"><div class="cardhd"><span class="accname">${escapeHtml(nm)}</span>${badge(st.phase)}</div>` +
      `<div class="report">${escapeHtml(st.message || (st.ok ? "状态正常" : "尚未运行"))}</div>` +
      `<div class="meta">${meta.join(" · ")}</div>` + // meta 内各字段已在构造时逐项转义
      `<div class="meta">闸门：${gate.map((s) => escapeHtml(s)).join(" · ")}</div>` +
      `<details><summary>查看原始 JSON</summary><pre>${escapeHtml(JSON.stringify({ account: { uid: a.uid, nickname: a.nickname, aha_device_id: a.aha_device_id, token_expires_at: fmtCST(a.expires_at) }, guard, state: st }, null, 2))}</pre></details></div>`);
  }
  const body = any
    ? cards.join("")
    : '<div class="card">尚未录入任何账号。通过 <code>/login-url</code> + <code>/callback</code>（需 <code>X-Admin-Token</code>）录入后此页会展示账号与 Token 状态。</div>';
  const cronBlock = cronCard(hb); // 与首页共用同一张卡（见 cronCard）
  const inner =
    '<div class="hd"><h2>Trae 账号状态</h2><span class="sub">Token 到期 / 最近运行 · 不显示 Token 明文</span></div>' +
    toolbar() + cronBlock + body +
    '<p class="sub" style="margin-top:8px;">本页不含任何 Token；程序调用时返回 JSON。</p>';
  // 不自动刷新：该页一次要读 list + 每账号 3 次 KV，60 秒一轮会持续消耗免费额度
  // （KV 免费版 list 仅 1000 次/天）。要刷新手动按 F5 即可。
  return htmlRes(pageShell("Trae 账号状态", inner, false));
}

/* —— /run：手动签到结果页 —— */
function renderRunResult(result) {
  const cards = (result.accounts || []).map((s) => {
    const nm = s.nickname || (s.uid ? "UID " + String(s.uid).slice(-4) : "未命名");
    const meta = [];
    if (s.phase === "already" && s.credits != null) meta.push("当前签到积分 " + s.credits);
    else if (s.credits) meta.push("本次 +" + s.credits + " 积分");
    if (s.usage && s.usage.remaining != null) meta.push("剩余 " + s.usage.remaining + " 积分额度");
    return '<div class="card"><div class="cardhd"><span class="accname">' + escapeHtml(nm) + "</span>" + badge(s.phase) + "</div>" +
      '<div class="report">' + escapeHtml(s.message || "-") + "</div>" +
      (meta.length ? '<div class="meta">' + meta.map((m) => escapeHtml(m)).join(" · ") + "</div>" : "") +
      "</div>";
  }).join("");
  const inner =
    '<div class="hd"><h2>签到执行结果</h2><span class="sub">' + escapeHtml(result.ran_at) + " · " + escapeHtml(triggerLabel(result.trigger)) + " · 共 " + result.count + " 个账号</span></div>" +
    toolbar() + cards +
    "<details><summary>查看本次完整 JSON</summary><pre>" + escapeHtml(JSON.stringify(result, null, 2)) + "</pre></details>";
  return htmlRes(pageShell("Trae 签到结果", inner, false)); // 不自动刷新，避免定时重复执行
}

/* —— /logs 日志列表（行内可展开完整日志，无独立详情页） —— */
// 拉取日志键（自动翻页，上限 10 页防御异常数据量），按 metadata.ts 倒序取最近 LOG_LIST_LIMIT 条。
// 兼容新旧两种键格式（log:uid:日期:ms 与 log:ms:uid）：排序与账号过滤一律依据 metadata，不依赖 KV 键序。
async function listLogEntries(kv, filterUid) {
  const all = [];
  let cursor;
  for (let i = 0; i < 10; i++) {
    const page = await kv.list({ prefix: "log:", limit: 1000, cursor });
    for (const k of page.keys) {
      const m = k.metadata || {};
      if (filterUid && String(m.uid || "") !== String(filterUid)) continue;
      all.push({ name: k.name, m });
    }
    if (page.list_complete) break;
    cursor = page.cursor;
  }
  all.sort((a, b) => (b.m.ts || 0) - (a.m.ts || 0));
  return all.slice(0, LOG_LIST_LIMIT);
}

async function renderLogs(env, filterUid) {
  const entries = await listLogEntries(env.KV, filterUid);
  const rowHtml = [];
  for (const k of entries) {
    const m = k.m;
    const body = (await env.KV.get(k.name)) || "";
    // 执行来源：新日志读 metadata.trigger；历史日志（该字段是后加的）从正文首行的 (cron)/(manual) 兜底解析
    const trigger = m.trigger || (body.match(/\((cron|manual)\)/) || [])[1] || "";
    rowHtml.push(`<tr>
      <td data-label="时间(北京)" style="padding:8px 10px;white-space:nowrap;color:#6B7280;font-size:12px;">${escapeHtml(fmtCST(m.ts))}<br><span style="color:#8A919C;">${escapeHtml(triggerLabel(trigger))}</span></td>
      <td data-label="结果" style="padding:8px 10px;">${badge(m.phase)}</td>
      <td data-label="账号" style="padding:8px 10px;font-size:13px;">${escapeHtml(m.nick || (m.uid ? "UID " + String(m.uid).slice(-4) : "-"))}</td>
      <td data-label="说明" style="padding:8px 10px;font-size:13px;color:#374151;">${escapeHtml(m.msg || "")}</td>
      <td style="padding:8px 10px;"><details><summary style="color:#2E7E96;font-size:12px;cursor:pointer;">详情</summary>
        <pre style="margin-top:6px;max-height:320px;overflow:auto;">${escapeHtml(body)}</pre></details></td>
    </tr>`);
  }
  // 无数据时也渲染表格与表头（与 WorkBuddy 版一致），tbody 放一条跨列提示
  const rows = rowHtml.join("") ||
    `<tr><td colspan="5" class="sub" style="padding:18px 10px;">暂无运行记录，点上方「立即签到」执行一次后即可看到。</td></tr>`;
  const inner = `
    <div class="hd"><h2>Trae 签到运行日志</h2>
    <span class="sub">最近 ${LOG_LIST_LIMIT} 条 · 每 60 秒自动刷新 · 仅保留 30 天</span></div>
    ${toolbar()}
    <hr>
    <div class="tbl-scroll"><table class="logtbl">
      <thead><tr><th>时间(北京)</th><th>结果</th><th>账号</th><th>说明</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  return htmlRes(pageShell("Trae 签到日志", inner, true));
}

// ============================================================
// HTTP 路由
// ============================================================
function requireAdmin(req, env) {
  if (!env.ADMIN_TOKEN)
    return new Response(JSON.stringify({ error: "服务端未配置 ADMIN_TOKEN 密钥" }), { status: 500, headers: JSON_H });
  const got = req.headers.get("X-Admin-Token") || "";
  if (!safeEqual(got, env.ADMIN_TOKEN)) {
    if (wantsHtml(req))
      return new Response(pageShell("未授权",
        '<div class="card warn" style="color:#B03A3C;">此接口需要管理员口令：请用 PowerShell / curl 携带请求头 <code>X-Admin-Token</code> 调用（用法见 README）。</div>', false),
        { status: 401, headers: HTML_H });
    return new Response(JSON.stringify({ error: "unauthorized：需要 X-Admin-Token 头" }), { status: 401, headers: JSON_H });
  }
  return null;
}
async function readJson(req) { try { return await req.json(); } catch { return {}; } }
// 浏览器查看时渲染页面；非浏览器调用时返回 JSON
function wantsHtml(req) {
  return (req.headers.get("accept") || "").includes("text/html");
}

async function handleFetch(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method.toUpperCase();

  // —— 根路径：首页（账号 / 立即签到 / 运行日志 / 可用操作，绝不执行任务）——
  if (path === "/" && method === "GET") {
    if (wantsHtml(req)) return renderHome(env);
    return new Response(JSON.stringify({
      ok: true,
      report: "Trae 签到 Worker 运行中。路径：/run（立即签到）、/status（账号状态）、/logs（运行日志）；浏览器访问为可视化页面。录入/删除凭证与手动刷新 Token 的 /login-url、/callback、/remove、/refresh 需请求头 X-Admin-Token。",
    }), { headers: JSON_H });
  }

  // —— 公开：运行日志列表 / 账号状态 / 立即签到（均为 GET）——
  if (path === "/logs" && method === "GET") {
    const uid = url.searchParams.get("uid");
    return wantsHtml(req) ? renderLogs(env, uid) : renderLogsJson(env, uid);
  }

  if (path === "/status" && method === "GET") {
    if (wantsHtml(req)) return renderStatus(env);
    const { keys } = await env.KV.list({ prefix: "acct:" });
    const accounts = [];
    for (const { name } of keys) {
      const a = await getJSON(env.KV, name, null);
      if (!a) continue;
      const st = await getJSON(env.KV, stateKey(a.uid), {});
      const guard = await loadGuard(env.KV, a.uid);
      accounts.push({
        uid: a.uid, nickname: a.nickname, aha_device_id: a.aha_device_id,
        token_expires: fmtCST(a.expires_at), state: st, guard, // 不含任何 access/refresh token
      });
    }
    return new Response(JSON.stringify({ accounts, cron_last: await getJSON(env.KV, CRON_KEY, null) }), { headers: JSON_H });
  }

  if (path === "/run" && method === "GET") {
    const result = await runAll(env, "manual"); // 与 Cron 一致：走完整闸门（限频暂停/间隔/每日上限）
    if (wantsHtml(req)) return renderRunResult(result);
    return new Response(JSON.stringify(result), { headers: JSON_H });
  }
  if (path === "/run" && method === "POST")
    return new Response(JSON.stringify({ error: "method not allowed：/run 请用 GET 访问" }), { status: 405, headers: JSON_H });

  // —— 录入/删除凭证、手动刷新 Token 的接口需要 X-Admin-Token ——
  if (path === "/login-url" || path === "/callback" || path === "/remove" || path === "/refresh") {
    const deny = requireAdmin(req, env);
    if (deny) return deny;

    if (path === "/refresh" && method === "GET") {
      const result = await refreshAllTokens(env);
      return new Response(JSON.stringify({ ok: true, ...result }), { headers: JSON_H });
    }

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
        // 按元数据 uid 匹配删除该账号的历史日志
        let cursor;
        for (let i = 0; i < 10; i++) {
          const page = await env.KV.list({ prefix: "log:", limit: 1000, cursor });
          for (const k of page.keys) {
            const m = k.metadata || {};
            if (String(m.uid || "") === uid) {
              await env.KV.delete(k.name);
              logsDeleted++;
            }
          }
          if (page.list_complete) break;
          cursor = page.cursor;
        }
      }
      return new Response(JSON.stringify({ ok: true, uid, deleted: ["acct", "guard", "state"], logs_deleted: logsDeleted }), { headers: JSON_H });
    }

    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: JSON_H });
  }

  if (wantsHtml(req))
    return new Response(pageShell("Not Found",
      '<div class="card">页面不存在。返回 <a href="/">首页</a>，可用路径：/run、/status、/logs。</div>', false),
      { status: 404, headers: HTML_H });
  return new Response("Not Found", { status: 404 });
}

// /logs 的 JSON 输出（复用列表逻辑；uid 打码、不暴露键名，与页面脱敏一致）
async function renderLogsJson(env, filterUid) {
  const mask = (v) => String(v || "").replace(/(\d{4})\d+(\d{4})/, "$1••••$2");
  const logs = (await listLogEntries(env.KV, filterUid)).map((k) => ({
    ts: k.m.ts, uid: mask(k.m.uid), nick: k.m.nick, ok: k.m.ok, phase: k.m.phase,
    trigger: k.m.trigger || null, // 历史日志的 metadata 无此字段（不读正文，保持接口轻量）
    msg: k.m.msg,
  }));
  return new Response(JSON.stringify({ count: logs.length, logs }), { headers: JSON_H });
}

export default {
  async fetch(req, env) {
    try { return await handleFetch(req, env); }
    catch (e) {
      return new Response(JSON.stringify({ error: String((e && e.message) || e) }), { status: 500, headers: JSON_H });
    }
  },
  async scheduled(controller, env) { // Cron：走完整闸门
    // controller 由 Cloudflare 传入，带着「实际使用的 cron 表达式」和「计划触发时间」。
    // 记下来才能核对面板上配的表达式是否真的生效（之前这两个值是被丢掉的）。
    const cronExpr = String((controller && controller.cron) || "");
    const planSec = Math.floor(Number((controller && controller.scheduledTime) || Date.now()) / 1000);
    // 入口先打一行实时日志：Cloudflare 的实时日志由平台保存、不依赖 KV，
    // 判断「触发器到底有没有被调用」看这一行最直接（/logs 依赖 KV，KV 异常时会一起静默）。
    console.log("[cron] 已触发", cronExpr, fmtCST(nowSec()));
    // 心跳：进 scheduled 的第一件事就把「我来过」落盘，不依赖后续任何逻辑。
    // 这样即便账号遍历失败、或一个账号都没有，也能证明触发器确实被调度过。
    try {
      await setJSON(env.KV, CRON_KEY, { ts: nowSec(), cron: cronExpr, plan_at: planSec, plan_at_str: fmtCST(planSec) });
    } catch (e) {
      console.error("cron 心跳写入失败（KV 不可用？）：", (e && e.message) || e);
    }
    let result = null;
    try {
      result = await runAll(env, "cron");
    } catch (e) {
      // 兜底：runAll 在账号遍历前失败（如 kv.list 抛错）时，每个账号的 try/catch 都没机会执行，
      // state 和 log 都不会写，/logs 上会「什么都看不到」。这里补一条降级日志留证。
      const msg = String((e && e.message) || e);
      console.error("cron runAll 失败：", msg);
      try {
        const ts = nowSec(), tsMs = Date.now();
        await env.KV.put(`log:${tsMs}:cron`,
          `# CRON  ${fmtCST(ts)} (cron)\n结果：error  ${msg}\n\n[FATAL] 账号遍历前失败：${msg}\n`,
          {
            expirationTtl: LOG_TTL,
            metadata: { ts, uid: "", nick: "CRON", ok: false, phase: "error", trigger: "cron", msg: msg.slice(0, 80) },
          });
      } catch {}
      return; // 已在上面留了 FATAL 日志，不再往下补「0 账号」那条
    }
    // 0 账号时 runAll 的 for 循环不会执行、一条日志都不会写，
    // 结果「没配账号」和「触发器没跑」在 /logs 上长得一模一样。补一条留痕，让 cron 是否执行过永远可查。
    if (!result || !result.count) {
      try {
        const ts = nowSec(), tsMs = Date.now();
        await env.KV.put(`log:${tsMs}:cron`,
          `# CRON  ${fmtCST(ts)} (cron)\n结果：skipped  未配置任何账号\n\n[WARN] 本次 Cron 已执行，但 KV 中没有 acct: 账号，无需签到。\n`,
          {
            expirationTtl: LOG_TTL,
            metadata: { ts, uid: "", nick: "CRON", ok: true, phase: "skipped", trigger: "cron", msg: "cron 已执行，但未配置任何账号" },
          });
      } catch {}
    }
  },
};