# Trae 签到 Worker 部署与使用说明

一个跑在 Cloudflare Worker 上的 Trae Work 每日自动签到程序，由本地 Python 脚本改造而来。
**只有一个代码文件 `worker.js`，不需要安装 Node / npm / wrangler，在 Cloudflare 网页控制台粘贴即可。**

- 定时自动签到，先查状态再领取，**不会重复领**；
- Token 过期前 24 小时自动静默续期；
- 遇到服务器繁忙（9074）自动退避，等下一个周期再试；
- 运行日志存在 KV，浏览器打开 `/logs` 就能看，保留 30 天；
- 支持多账号（录入几个就自动签几个）。

---

## 目录

1. [准备工作](#1-准备工作)
2. [第一步：创建 Worker 并粘贴代码](#2-第一步创建-worker-并粘贴代码)
3. [第二步：创建 KV 并绑定](#3-第二步创建-kv-并绑定)
4. [第三步：设置管理口令 ADMIN_TOKEN](#4-第三步设置管理口令-admin_token)
5. [第四步：配置定时 Cron](#5-第四步配置定时-cron)
6. [第五步：取出 16 位 Aha 设备号（关键）](#6-第五步取出-16-位-aha-设备号关键)
7. [第六步：录入凭证（登录一次）](#7-第六步录入凭证登录一次)
8. [第七步：手动试跑并查看日志](#8-第七步手动试跑并查看日志)
9. [接口一览](#9-接口一览)
10. [日常运维与常见问题](#10-日常运维与常见问题)
11. [安全说明与卸载](#11-安全说明与卸载)

---

## 1. 准备工作

- 一个 **Cloudflare 账号**（免费即可），并已开启 `workers.dev` 子域名（首次进 Workers & Pages 时按提示设置一次，例如选一个你自己的子域名前缀）。
- 电脑上能正常登录 **Trae 客户端 / 网页**，并且本机装过 Trae 客户端（用来取设备号，见第五步）。
- 你的 Worker 访问地址，部署后形如：`https://<worker名>.<你的子域>.workers.dev`，下面统一用 `$base` 代指。
- 命令在 **Windows PowerShell** 里执行（开始菜单搜 PowerShell）。本说明给的是 PowerShell 原生命令，不依赖 curl 转义，最省心。

> 先在 PowerShell 里设两个变量，后面所有命令直接复用（替换成你自己的）：
> ```powershell
> $base  = "https://trae-checkin.你的子域.workers.dev"
> $token = "你自己设定的管理口令"
> $h = @{ "X-Admin-Token" = $token }
> ```

---

## 2. 第一步：创建 Worker 并粘贴代码

1. 登录 Cloudflare 控制台，左侧进 **Workers & Pages** → **Create**（创建）→ 选 **Workers**（从 Hello World 模板开始即可）。
2. 给 Worker 起个名，例如 `trae-checkin`，点 **Deploy / 部署**。
3. 部署后点 **Edit code / 编辑代码**，把编辑器里自带的内容**全部删掉**。
4. 用记事本打开本目录的 **`worker.js`**，全选复制，整段粘贴进网页编辑器。
5. 点右上角 **Deploy / 部署**。

部署成功后，访问 `https://<worker名>.<你的子域>.workers.dev/` 能看到一个写着"服务运行中、本页面不执行任何签到任务"的页面，就说明代码上线了。

---

## 3. 第二步：创建 KV 并绑定

KV 是 Cloudflare 的键值存储，用来存凭证、限频状态和日志。

1. 控制台左侧进 **Storage & Databases（存储和数据库）** → **KV** → **Create a namespace（创建命名空间）**，名字随意，例如 `TRAE`，创建。
2. 回到你刚建的 Worker → **Settings（设置）** → 找到 **Bindings（绑定）** → **Add（添加）** → 选 **KV namespace**。
3. **变量名（Variable name）必须填 `KV`**（大写，代码里就认这个名字），命名空间选刚建的 `TRAE`，保存。

> 变量名填错（比如小写 `kv`）会导致运行时报错，务必是大写 `KV`。

---

## 4. 第三步：设置管理口令 ADMIN_TOKEN

录入凭证、手动签到等管理接口需要这个口令，避免别人乱调。

1. Worker → **Settings** → **Variables and Secrets（变量和机密）** → **Add**。
2. 类型选 **Secret（加密/机密）**，名称填 **`ADMIN_TOKEN`**，值填一串你自己的口令（建议长一点、随机一点）。
3. 保存并**重新部署一次**（部分情况下密钥需要重新部署才生效）。
4. 把同一个口令填回 PowerShell 的 `$token` 变量（见第 1 节）。

---

## 5. 第四步：配置定时 Cron

Cron 按 **UTC 时间**执行。本项目用**一条**表达式实现每 6 小时跑一次：

1. Worker → **Settings** → **Triggers（触发器）** → **Cron Triggers** → **Add**。
2. 表达式填：
   ```
   0 */6 * * *
   ```
3. 保存。它等于北京时间 **08:00、14:00、20:00、02:00** 各触发一次（UTC=北京减 8 小时）。

> 第一次成功签到后，当天剩下的几次会先查到"已签到"然后直接收手，**不会重复领、也不会多花 claim 次数**。
> 想改频率就在这里改表达式，例如：
> - 每 3 小时：`0 */3 * * *`
> - 每天两次（北京 09:00 和 22:00）：`0 1,14 * * *`
> - 每天一次（北京 22:00）：`0 14 * * *`

---

## 6. 第五步：取出 16 位 Aha 设备号（关键）

这是**最容易踩坑、也最关键**的一步。签到接口要求请求头 `x-device-id` 是 Trae 客户端的 **16 位十进制设备号**；用随机字符会一直返回 9074。这个号在你本机 Trae 客户端的 `storage.json` 里。

**最简单：PowerShell 跑下面这段，自动把设备号找出来：**
```powershell
$paths = @(
  "$env:APPDATA\TRAE SOLO CN\User\globalStorage\storage.json",
  "$env:APPDATA\Trae CN\User\globalStorage\storage.json",
  "$env:APPDATA\Trae\User\globalStorage\storage.json"
)
foreach ($p in $paths) {
  if (Test-Path $p) {
    Select-String -Path $p -Pattern 'iCubeAuthInfo://icube-dc:(\d{8,16})' -AllMatches |
      ForEach-Object { $_.Matches } |
      ForEach-Object { "找到设备号: " + $_.Groups[1].Value }
  }
}
```
输出形如 `找到设备号: 3156057067629600`，**把这串数字记下来**（下面叫 `$aha`）。

手动找也行：用记事本打开上面任一存在的 `storage.json`，搜索 `iCubeAuthInfo://icube-dc:`，冒号后面那串 16 位数字就是。

> 请用**与该客户端登录的同一个 Trae 账号**去做第七步，保证账号和设备号一致。

---

## 7. 第六步：录入凭证（登录一次）

录入只需要做一次；以后 Token 会自动续期，除非 refresh token 也失效（届时重做本步即可）。

### 7.1 获取登录链接
```powershell
Invoke-RestMethod -Uri "$base/admin/login-url" -Headers $h
```
返回 JSON 里的 `login_url` 就是登录地址（**现取现用**，每次都会生成新的）。

### 7.2 浏览器登录并复制回调地址
1. 复制 `login_url`，在浏览器打开，用手机号/验证码登录你的 Trae 账号。
2. 登录成功后浏览器会跳转到一个 **`http://127.0.0.1:18080/authorize?...` 开头、并且显示"无法访问此网站/打不开"的页面——这是正常的**。
3. **把浏览器地址栏里这一整条完整 URL 复制下来**（很长，带 `refreshToken=...` 等参数）。

### 7.3 提交给 Worker
```powershell
# 把下面两行替换成你的真实值：
$cb  = "粘贴上一步复制的 127.0.0.1 开头的完整地址"
$aha = "第六步拿到的16位设备号"

$body = @{ callback_url = $cb; aha_device_id = $aha } | ConvertTo-Json
Invoke-RestMethod -Uri "$base/admin/callback" -Method Post -Headers $h -ContentType "application/json" -Body $body
```
成功会返回 `ok=true`、你的 `uid / nickname / aha_device_id / expires_at_str`。看到这个就说明凭证已存进 KV。

> 多账号：换一个 Trae 账号重复 7.1～7.3 即可，Cron 会自动遍历所有已录入账号。

---

## 8. 第七步：手动试跑并查看日志

### 8.1 立即手动跑一次（不等定时）
```powershell
Invoke-RestMethod -Uri "$base/admin/run" -Method Post -Headers $h
```
返回里 `accounts[0].phase` 含义：
- `claimed`：本次签到成功；
- `already`：今天已经签过了；
- `rate_limited`：撞上服务器繁忙 9074，已自动安排下个周期再试；
- `login_required`：登录态失效，需要重做第七步；
- `skipped` / `error`：被限频闸门跳过 / 其他错误，看 message。

### 8.2 浏览器看日志（收藏这个地址）
直接打开（**不需要口令**）：
```
https://<worker名>.<你的子域>.workers.dev/logs
```
- 最近 50 次运行，每 60 秒自动刷新，按时间倒序；
- 结果用颜色区分：绿色=成功/已签到，黄色=限频，红色=需重新登录/错误，灰色=跳过；
- 点"详情"看这一次的完整过程日志；日志只保留 30 天。

### 8.3 查看账号状态（可选）
```powershell
Invoke-RestMethod -Uri "$base/admin/status" -Headers $h
```
返回各账号的昵称、设备号、Token 到期时间、最近一次运行状态（**不会返回 Token 明文**）。

---

## 9. 接口一览

| 路径 | 方法 | 是否需要 `X-Admin-Token` | 作用 |
|---|---|---|---|
| `/` | GET | 否 | 静态说明页，**不执行任何签到** |
| `/health` | GET | 否 | 存活探针 |
| `/logs` | GET | 否 | 日志列表页（已脱敏，不含 Token） |
| `/log?id=<日志键>` | GET | 否 | 单条日志详情，只允许读 `log:` 开头的键 |
| `/admin/login-url` | GET | 是 | 生成 Trae 登录链接 |
| `/admin/callback` | POST | 是 | 录入凭证，JSON：`{"callback_url":"...","aha_device_id":"..."}` |
| `/admin/status` | GET | 是 | 账号与 Token/签到状态 |
| `/admin/run` | POST | 是 | 立即手动签到一次（无需任何参数） |

> 管理接口的鉴权头是 `X-Admin-Token: <你的 ADMIN_TOKEN>`。浏览器不方便加头，所以管理操作用上面的 PowerShell（或 Postman、Apifox 之类）；日志页特意做成免口令，方便直接收藏。

**习惯用 curl 的话**（Windows 上请用系统自带的 `curl.exe`，不要用 `curl` 别名）：
```powershell
curl.exe -H "X-Admin-Token: 你的口令" "$base/admin/login-url"
curl.exe -X POST -H "X-Admin-Token: 你的口令" -H "Content-Type: application/json" -d "{\"callback_url\":\"回调地址\",\"aha_device_id\":\"设备号\"}" "$base/admin/callback"
curl.exe -X POST -H "X-Admin-Token: 你的口令" "$base/admin/run"
```

---

## 10. 日常运维与常见问题

**Q：会重复签到 / 多领吗？**
不会。每次先调 status 免费查询，发现"今日已签到"立即收手，只有未签到才发一次 claim。

**Q：返回 9074「当前参与用户太多/操作太频繁」怎么办？**
两种可能：① 服务器繁忙，这是常态，程序已自动按 30/60/120/240/360 分钟退避，等下一个 6 小时 Cron 即可，也可以随时 `/admin/run` 手动补一次；② **Aha 设备号不对**（用成了随机号/UUID）——这种会一直 9074，请回到第五步核对 `aha_device_id` 是 16 位真实数字，并重新第七步录入。

**Q：日志里出现红色"需重新登录 login_required"？**
说明 refresh token 也过期了，无法静默续期。重做第 7 步（`login-url` → 登录 → `callback`）即可恢复，KV 里的旧凭证会被覆盖。

**Q：我现在就想签到，不想等定时？**
随时 `POST /admin/run`，手动触发会绕过"间隔/暂停/每日上限"闸门立即尝试（仍只 claim 一次）。

**Q：日志时间是哪个时区？**
页面和接口都按**北京时间（UTC+8）**显示。Cron 表达式本身是 UTC，对照见第四步。

**Q：免费额度够吗？**
绰绰有余。免费版每天 10 万次请求、KV 每天 10 万读 / 1000 写；本程序一天十几次读写、每次只有几个很小的网络请求和 JSON 解析。

**Q：怎么确认定时真的在跑？**
Worker → **Logs / 日志（实时日志）**能看到触发记录；Triggers 页面也能看到 Cron 配置与历史；结果最终都体现在 `/logs`。也可以在 Cron 设置旁边用"手动触发/Run once"测试 `scheduled`。

**Q：`/logs` 是公开的，安全吗？**
日志页不需要口令是为了方便收藏，但内容**不含任何 Token**，只显示昵称、结果和过程，且 `/log` 被限制只能读日志键。你的 `workers.dev` 地址本身不公开、别人很难猜。如果你仍希望日志页也加口令，可在 `worker.js` 的 `/logs`、`/log` 分支加上和 `/admin` 一样的口令校验。

**Q：PowerShell 报 `Invoke-RestMethod` 401 / unauthorized？**
说明 `$token` 和控制台里的 `ADMIN_TOKEN` 不一致，或密钥设置后没重新部署；检查请求头 `X-Admin-Token`。

**Q：`callback` 报"ExchangeToken 鉴权失败"？**
回调链接过期或不完整。重新走 7.1 取新链接、重新登录、复制**完整**地址再提交。

**Q：换了设备 / 重装了 Trae，设备号变了？**
用新设备号重做第七步覆盖即可。

---

## 11. 安全说明与卸载

**安全要点**
- `ADMIN_TOKEN` 用加密类型（Secret）保存，不要写进代码、不要外泄。
- 凭证（含 Token）只存在你自己账号下的 KV，静态加密；任何 HTTP 接口都不返回 Token 明文。
- 根路径 `/` 不执行任何任务，避免被扫描器误触发。
- 建议用与 Trae 客户端一致的账号 + 真实 Aha 设备号。

**彻底卸载**
1. Workers & Pages 里删除这个 Worker；
2. Storage & Databases → KV 里删除对应命名空间（凭证、状态、日志一并清除）；
3. 无需清理本地任何东西（本方案不在你电脑上常驻，本地只用 PowerShell 发了几次请求）。

---

### 附：文件清单
```
trae-checkin-worker/
├── worker.js   # 全部代码（粘贴到 Cloudflare 控制台）
└── README.md   # 本说明
```
