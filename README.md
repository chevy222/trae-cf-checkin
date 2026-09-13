# Trae 签到 Worker 部署与使用说明

**只有一个代码文件 `worker.js`，不需要安装 Node / npm / wrangler，在 Cloudflare 网页控制台粘贴即可。**

- 定时自动签到，先查状态再领取，**不会重复领**；
- Token 过期前 72 小时自动静默续期；也可随时用 `/refresh` 手动强制刷新（需口令）；
- 遇到服务器繁忙（9074）自动退避，等下一个周期再试；
- 运行日志存在 KV，浏览器打开 `/logs` 就能看，保留 30 天；日志会标注是**定时触发**还是**手动跑的**；
- 定时任务带独立心跳，首页与 `/status` 一眼看出"上次 Cron 什么时候跑的"（表达式与计划时间在 `/status` JSON 的 `cron_last` 字段里）；
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
- 命令在 **Windows PowerShell** 里执行（开始菜单搜 PowerShell）。本说明给的是 PowerShell 原生命令，不依赖 curl 转义，最省心；PowerShell 变量统一在第五步初始化。

---

## 2. 第一步：创建 Worker 并粘贴代码

1. 登录 Cloudflare 控制台，左侧进 **Workers & Pages** → **Create**（创建）→ 选 **Workers**（从 Hello World 模板开始即可）。
2. 给 Worker 起个名，例如 `trae-checkin`，点 **Deploy / 部署**。
3. 部署后点 **Edit code / 编辑代码**，把编辑器里自带的内容**全部删掉**。
4. 用记事本打开本目录的 **`worker.js`**，全选复制，整段粘贴进网页编辑器。
5. 点右上角 **Deploy / 部署**。

部署成功后，访问 `https://<worker名>.<你的子域>.workers.dev/` 能看到首页：已配置账号、**立即签到**、**运行日志**、**可用操作**，就说明代码上线了（首页不执行任何签到任务）。

---

## 3. 第二步：创建 KV 并绑定

KV 是 Cloudflare 的键值存储，用来存凭证、限频状态和日志。

1. 控制台左侧进 **Storage & Databases（存储和数据库）** → **KV** → **Create a namespace（创建命名空间）**，名字随意，例如 `TRAE`，创建。
2. 回到你刚建的 Worker → **Settings（设置）** → 找到 **Bindings（绑定）** → **Add（添加）** → 选 **KV namespace**。
3. **变量名（Variable name）必须填 `KV`**（大写，代码里就认这个名字），命名空间选刚建的 `TRAE`，保存。

> 变量名填错（比如小写 `kv`）会导致运行时报错，务必是大写 `KV`。

---

## 4. 第三步：设置管理口令 ADMIN_TOKEN

只有"录入/删除凭证"的三个接口（`/login-url`、`/callback`、`/remove`）需要这个口令，防止别人往你的 KV 写入或删除凭证；查看状态 `/status`、手动签到 `/run`、日志 `/logs` 都是公开的，不需要口令。

1. Worker → **Settings** → **Variables and Secrets（变量和机密）** → **Add**。
2. 类型选 **Secret（加密/机密）**，名称填 **`ADMIN_TOKEN`**，值填一串你自己的口令（建议长一点、随机一点）。
3. 保存并**重新部署一次**（部分情况下密钥需要重新部署才生效）。
4. 同一个口令第五步会填进 PowerShell 的 `$token` 变量（在 7.1、7.3 录入凭证和 8.4 删除账号时用到）。

---

## 5. 第四步：配置定时 Cron

Cron 表达式按 **UTC 时间**执行，北京时间 = UTC+8（UTC 小时 = 北京小时 − 8；减到负数就加 24、相当于 UTC 前一天，但"日"字段仍填 `*`，每天照常触发）。

1. Worker → **Settings** → **Triggers（触发器）** → **Cron Triggers** → **Add**。
2. 按你想要的**北京时间**从下表选一条表达式填进去，保存。

> **保存后不会立刻生效**：Cron 触发器的新增 / 修改 / 删除最多需要 **15 分钟**才传播到 Cloudflare 全网。所以刚加完触发器等两三分钟还没动静是正常的，先别怀疑代码。
>
> 想立刻验证是否配通，可以**临时**把表达式改成 `*/10 * * * *`（每 10 分钟一次），保存后等 15~25 分钟，看 `/status` 页面上那张「定时任务（Cron）」卡片有没有亮起来；确认通了再改回正式表达式。

**推荐每天北京时间 08:00 签到**，表达式：
```
0 0 * * *
```

**UTC 对照表（每天一次，格式 `分 时 * * *`）**

| 想在北京时间 | UTC 时间 | 填的表达式 |
| --- | --- | --- |
| 00:00 | 前一天 16:00 | `0 16 * * *` |
| 02:00 | 前一天 18:00 | `0 18 * * *` |
| 06:00 | 前一天 22:00 | `0 22 * * *` |
| **08:00（推荐）** | 00:00 | `0 0 * * *` |
| 09:00 | 01:00 | `0 1 * * *` |
| 10:00 | 02:00 | `0 2 * * *` |
| 12:00 | 04:00 | `0 4 * * *` |
| 14:00 | 06:00 | `0 6 * * *` |
| 18:00 | 10:00 | `0 10 * * *` |
| 20:00 | 12:00 | `0 12 * * *` |
| 22:00 | 14:00 | `0 14 * * *` |

> 想换分钟就把第一个 `0` 改成对应分钟（一般保持 0）。每天只跑这一次即可：程序每次先查签到状态，已签到会直接收手，**不会重复领、也不会多花 claim 次数**。

---

## 6. 第五步：取出 16 位 Aha 设备号（关键）

这是**最容易踩坑、也最关键**的一步。签到接口要求请求头 `x-device-id` 是 Trae 客户端的 **16 位十进制设备号**；用随机字符会一直返回 9074。这个号在你本机 Trae 客户端的 `storage.json` 里。

先打开 **Windows PowerShell**（开始菜单搜 PowerShell），初始化下面变量，后面命令都在**同一个窗口**里复用（替换成你自己的 Worker 地址和管理口令，地址结尾不要带斜杠；其中 `$h` 只在 7.1、7.3 录入凭证时用到）：
```powershell
$base  = "https://trae-checkin.你的子域.workers.dev"
$token = "你自己设定的管理口令"
$h = @{ "X-Admin-Token" = $token }
```

**保持这个 PowerShell 窗口，再跑下面这段，自动把设备号找出来：**
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

录入只需要做一次；以后 Token 会在到期前 72 小时内自动续期（想立即续可用 `/refresh`，见第 9 节），除非 refresh token 也失效（届时重做本步即可）。

### 7.1 获取并直接打开登录链接
```powershell
$r = Invoke-RestMethod "$base/login-url" -Headers $h
Start-Process $r.login_url
```
第二行会用默认浏览器**直接打开登录页**。不要把 `Invoke-RestMethod` 的结果直接打印在控制台看——返回的 `login_url` 很长，控制台表格会截断显示（值本身没丢，但复制不全）；存进变量再 `Start-Process` 打开最稳。如果只想复制不打开，用 `Set-Clipboard $r.login_url`。登录链接**现取现用**，每次都会生成新的。

### 7.2 浏览器登录并复制回调地址
1. 登录页已由 7.1 自动打开，用手机号/验证码登录你的 Trae 账号（与 Aha 设备号同一账号）。
2. 登录成功后浏览器会跳转到一个 **`http://127.0.0.1:18080/authorize?...` 开头、并且显示"无法访问此网站/打不开"的页面——这是正常的**。
3. 在该页面地址栏点一下，`Ctrl+A`、`Ctrl+C`，**把这一整条完整 URL 复制下来**（很长，带 `refreshToken=...` 等参数；在浏览器里复制不会被截断）。

### 7.3 提交给 Worker
```powershell
# 把下面两行替换成你的真实值：
$cb  = "粘贴上一步复制的 127.0.0.1 开头的完整地址"
$aha = "第六步拿到的16位设备号"

$body = @{ callback_url = $cb; aha_device_id = $aha } | ConvertTo-Json
Invoke-RestMethod -Uri "$base/callback" -Method Post -Headers $h -ContentType "application/json" -Body $body
```
成功会返回 `ok=true`、你的 `uid / nickname / aha_device_id / expires_at_str`。看到这个就说明凭证已存进 KV。

> 多账号：换一个 Trae 账号重复 7.1～7.3 即可，Cron 会自动遍历所有已录入账号。

---

## 8. 第七步：手动试跑并查看日志

### 8.1 立即手动跑一次（不等定时，无需口令）
```powershell
Invoke-RestMethod -Uri "$base/run"
```
也就是**直接在浏览器打开 `$base/run`**（GET）即可触发（逻辑与 Cron 一致：受限频闸门/间隔/每日上限保护，只有 Token 临期才刷新）。浏览器会返回结果页；返回的 `accounts[0].phase` 含义：
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
- 最近 30 次运行，每 60 秒自动刷新，按时间倒序；
- 结果用颜色区分：绿色=成功/已签到，黄色=限频，红色=需重新登录/错误，灰色=跳过；
- 时间列第二行标注**执行来源**：「定时触发」或「手动 · /run」，一眼区分这一次是谁触发的（早期没有该标注的历史日志会从正文自动解析，同样能正确显示）；
- 每行的「详情」可**在列表内直接展开**这一次的完整过程日志（无需单独页面）；日志只保留 30 天。

### 8.3 查看账号状态（可选，无需口令）
直接用浏览器打开（**不需要口令**）：
```
https://<worker名>.<你的子域>.workers.dev/status
```
返回每个账号的昵称、设备号、Token 到期时间、最近一次运行状态，以及**限频闸门**（今日 claim 次数 / 是否处于限频暂停 / 连续限频次数 / 距下次可领取还有多久）——本次被"跳过"时，看一眼闸门那行就知道卡在哪一档（**不会返回 Token 明文**）；命令行 `Invoke-RestMethod -Uri "$base/status"` 返回 JSON，闸门状态在 `guard` 字段里。

页面顶部还有一张 **「定时任务（Cron）」** 卡片：显示**上次 Cron 触发的时间**。**这是判断「定时任务到底有没有跑」最直接的依据**——它由 `scheduled()` 进门第一件事写入 KV，不依赖账号是否配置，也不依赖当时有没有人盯着实时日志；卡片显示"尚无触发记录"就说明触发器没有被调度到（需要核对 Cloudflare 实际使用的表达式与计划时间时，程序调用 `/status` 看 JSON 的 `cron_last` 字段）。

### 8.4 删除某个账号（多账号时用）
先从 8.3 的结果里找到要删账号的 `uid`（一串数字），然后（需要口令）：
```powershell
$body = @{ uid = "要删除账号的uid" } | ConvertTo-Json
Invoke-RestMethod "$base/remove" -Method Post -Headers $h -ContentType "application/json" -Body $body
```
会删掉该账号的凭证、限频状态、最近快照和它的历史日志，其它账号不受影响；返回 `ok=true` 即成功。想保留它的历史日志就把 body 改成 `@{ uid = "..."; keep_logs = $true }`。

> 不想重新部署也能手动删：控制台 **Storage & Databases → KV → 你的命名空间 → View**，搜索该 uid，删除 `acct:<uid>`、`guard:<uid>`、`state:<uid>` 三个键即可（删掉 `acct:` 就不会再被签到；`log:<uid>:*` 是日志，可留着 30 天自动过期）。另有 `cron:last` 一个全局键，记录最近一次定时任务触发的心跳，不属于任何账号，可保留不管。

---

## 9. 接口一览

| 路径 | 方法 | 是否需要 `X-Admin-Token` | 作用 |
|---|---|---|---|
| `/` | GET | 否 | 首页：**定时任务心跳** / 账号 / 立即签到 / 运行日志 / 可用操作，**不执行任何签到** |
| `/logs` | GET | 否 | 日志列表页（已脱敏，不含 Token，**标注执行来源**，行内可展开完整日志） |
| `/refresh` | GET | **是** | 手动刷新所有账号 Token（强制换新，不受 72 小时阈值限制），程序调用返回 JSON |
| `/login-url` | GET | **是** | 生成 Trae 登录链接 |
| `/callback` | POST | **是** | 录入凭证，JSON：`{"callback_url":"...","aha_device_id":"..."}` |
| `/remove` | POST | **是** | 删除账号，JSON：`{"uid":"数字"}`，默认连日志一起删 |
| `/status` | GET | 否 | 账号、Token 到期、最近运行、限频闸门，以及**定时任务上次触发时间**（`cron_last`，含实际使用的表达式）；不含 Token 明文，浏览器=页面、程序调用=JSON |
| `/run` | GET | 否 | 立即手动签到一次（逻辑与 Cron 一致，受限频闸门保护），浏览器打开即触发 |

> 录入/删除凭证与手动刷新 Token 的 `/login-url`、`/callback`、`/remove`、`/refresh` 需要鉴权头 `X-Admin-Token: <你的 ADMIN_TOKEN>`，用 PowerShell（或 Postman、Apifox）调用；`/run`、`/status`、`/logs` 浏览器直接打开即可（`/run` 打开就会真的跑一次签到）。

**习惯用 curl 的话**（Windows 上请用系统自带的 `curl.exe`，不要用 `curl` 别名）：
```powershell
curl.exe -H "X-Admin-Token: 你的口令" "$base/login-url"
curl.exe -H "X-Admin-Token: 你的口令" "$base/refresh"
curl.exe -X POST -H "X-Admin-Token: 你的口令" -H "Content-Type: application/json" -d "{\"callback_url\":\"回调地址\",\"aha_device_id\":\"设备号\"}" "$base/callback"
curl.exe "$base/run"
curl.exe -X POST -H "X-Admin-Token: 你的口令" -H "Content-Type: application/json" -d "{\"uid\":\"要删除的uid\"}" "$base/remove"
```

---

## 10. 日常运维与常见问题

**Q：会重复签到 / 多领吗？**
不会。每次先调 status 免费查询，发现"今日已签到"立即收手，只有未签到才发一次 claim。

**Q：返回 9074「当前参与用户太多/操作太频繁」怎么办？**
两种可能：① 服务器繁忙，这是常态，程序已自动按 30/60/120/240/360 分钟退避，等下一次每日 Cron 即可，也可以随时打开 `$base/run` 手动补一次；② **Aha 设备号不对**（用成了随机号/UUID）——这种会一直 9074，请回到第五步核对 `aha_device_id` 是 16 位真实数字，并重新第七步录入。

**Q：Token 快到期了，想立刻刷新不想等自动续期？**
`Invoke-RestMethod "$base/refresh" -Headers $h`（GET，需口令）——强制给所有账号换新 Token，不受"剩 72 小时内才自动续"的阈值限制；返回里每个账号 `refreshed=true` 与新的有效期即成功。与签到共用并发锁，若恰逢定时任务在跑会返回"并发跳过"，稍等重试即可。

**Q：日志里出现红色"需重新登录 login_required"？**
说明 refresh token 也过期了，无法静默续期。重做第 7 步（`login-url` → 登录 → `callback`）即可恢复，KV 里的旧凭证会被覆盖。

**Q：我现在就想签到，不想等定时？**
随时打开 `$base/run`（GET，无需口令）。与 Cron 一致，同样受"间隔/暂停/每日上限"闸门保护；若在上次领取后 30 分钟内，或正处于限频暂停期/已达当日上限，本次会返回"跳过"（phase 为 skipped），不会重复领。具体卡在哪一档，打开 `$base/status` 看每个账号的**闸门**那一行即可。

**Q：日志时间是哪个时区？**
页面和接口都按**北京时间（UTC+8）**显示。Cron 表达式本身是 UTC，对照见第四步。

**Q：免费额度够吗？**
绰绰有余。免费版每天 10 万次请求、KV 每天 10 万读 / 1000 写；本程序每天定时只跑一次，一天就几次到十几次 KV 读写、每次只有几个很小的网络请求和 JSON 解析。

**Q：怎么确认定时真的在跑？**
按可靠性从高到低看三处：
1. **`/status` 页面顶部的「定时任务（Cron）」卡片**——显示上次 Cron 触发时间（JSON 对应 `cron_last`，其中仍可查 Cloudflare 实际使用的表达式）。这是最可靠的判据：它由 `scheduled()` 进门第一件事写入，不依赖账号是否配置，也不依赖当时有没有人看实时日志。
2. **`/logs` 列表**——时间列第二行会标注「定时触发」；看到标记就说明这次是 Cron 跑出来的。
3. Worker → **Logs / 日志（实时日志）**——能实时看到触发过程，但**只有当时开着页面才看得到**，事后无法回看，因此只作为辅助。

另外 Triggers 页面能看到 Cron 配置与执行历史（`Settings → Trigger Events → View events` 保留了最近 100 次调用）。也可以在 Cron 设置旁边用"手动触发 / Run once"测试 `scheduled`。

**Q：定时任务完全没有记录（`/logs` 里一条都没有，`/status` 的心跳卡也是空的）？**
说明 `scheduled()` **没有被调度过**——注意，Worker 代码里没有任何开关能影响定时任务的调度，所以这种情况下不必再翻代码。按顺序查这三件事：
1. **Triggers 页面里到底有没有条目**（`Settings → Triggers → Cron Triggers`）。遇到过"以为配好了，其实列表是空的"。
2. **触发器绑的 Worker 和你访问的域名是不是同一个**。看该 Worker 的「域」标签页，确认自定义域名确实绑在它身上——代码部署在 A、触发器配在 B，就会出现"手动能跑、定时全无"。
3. **是不是刚加完触发器**？见第四步的说明，变更最多要 15 分钟才生效；另外新建 Worker 或改过 Worker 名字后，触发事件记录最长要 30 分钟才显示。

确认配好后，可以随时打开 `$base/run` 手动补一次，逻辑与 Cron 完全一致。

**Q：页面底部的 `version` 是什么？**
是本次部署的构建版本，格式 `日期:当天第几次改动`——例如 `20260912:2` 表示 2026 年 9 月 12 日的第 2 次改动。它就是 `worker.js` 顶部的 `BUILD_VERSION` 常量，**当天第几个改动就写几**（跨天则换成当天日期、序号从 1 重新开始）。配合自动部署时，提交推送后刷新页面看这一行有没有变，就能立刻确认新版本上线了。如果没变，先 `Ctrl+F5` 强刷一下排除浏览器缓存。

**Q：`/logs` 是公开的，安全吗？**
日志页不需要口令是为了方便收藏，但内容**不含任何 Token**，只显示昵称、结果和过程，且日志列表只读 `log:` 前缀的键（无法读到 `acct:` 凭证）。你的 `workers.dev` 地址本身不公开、别人很难猜。如果你仍希望日志页也加口令，可在 `worker.js` 的 `/logs` 分支加上和 `/login-url` 一样的口令校验。

**Q：PowerShell 报 `Invoke-RestMethod` 401 / unauthorized？**
只有 `/login-url`、`/callback` 需要口令：说明 `$token` 和控制台里的 `ADMIN_TOKEN` 不一致，或密钥设置后没重新部署；检查请求头 `X-Admin-Token`。`/run`、`/status`、`/logs` 不需要口令，别给它们加 `-Headers $h`（加了也不影响）。

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
trae-cf-checkin/
├── worker.js   # 全部代码（粘贴到 Cloudflare 控制台）
└── README.md   # 本说明
```
