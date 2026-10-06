# ds-tts · 用 DeepSeek 官方朗读音色朗读 / 导出 / 接口化

> **English**: A DSH plugin that reads assistant messages aloud with DeepSeek's official TTS voices, exports audio files, and exposes a text-in/audio-out HTTP API.

[![DSH Plugin](https://img.shields.io/badge/DSH-plugin-4f46e5.svg)](https://github.com/liceses/awesome-dsh-plugin)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey.svg)
![Node](https://img.shields.io/badge/node-%E2%89%A522-339933.svg)

在 DSH Web GUI 里用 **DeepSeek 官方朗读音色**朗读对话、导出音频，并提供「文本进、音频出」的接口与工具。

- 🔊 每条助手消息可一键朗读（DS 官方音色：贝壳 `mira` / 白浪 `echo` / 海星 `stella` / 暗潮 `tide`）
- ⟳ 每条消息可**重新生成**：DS 每次合成的声音可能不同，缓存会让同文本秒回同一版，所以需要显式再要一版
- ⤓ 导出为音频文件下载，或存进当前会话工作区 `.dsh/tts/`
- 输入框旁的朗读入口：粘贴任意文本即可播放 / 重新生成 / 下载 / 存盘
- HTTP 接口 `POST /api/ds-tts/synthesize`：文本进、音频 URL 与文件出（命令行示例见 `scripts/tts-call.mjs`）
- 三个模型可见工具：`tts_speak` / `tts_voices` / `tts_status`

它和「本地 TTS 引擎」不是一回事：**声音是 DS 账号里的**，所以要有 DS 账号；代价是文本得先在
DS 那边走一趟（见下面 30 秒说明）。换来的是**不用装模型、不占显存、不调参**的官方音色。

---

## 目录

| 想了解 | 看这里 |
| --- | --- |
| 30 秒搞懂它为什么这么绕 | [它是怎么工作的](#how) |
| 亲手跑一次（含终端实测输出） | [快速开始](#quickstart) · [本次复核](#recheck) |
| 有哪些接口 / 参数怎么传 | [HTTP 接口](#http-api) · [命令行](#cli) · [模型工具](#tools) |
| 会不会泄露凭证 | [安全约定](#security) |
| 有哪些开关 | [配置](#config) |
| 出问题了怎么看 | [排障](#troubleshoot) |
| 它把东西放哪 | [数据落点](#storage) |
| 凭什么说"实测有效" | [已验证（作者记录）](#evidence) · [本次复核](#recheck) |
| 有什么坑 | [已知限制](#limits) |
| 想改代码 | [依赖](#deps) · [开发](#dev) · [代码地图](#codemap) |

---

<a id="quickstart"></a>
## 快速开始

**前置条件**（缺一个就跑不起来，先说清楚）：

1. 一个能用的 DSH 安装（本插件是 DSH 插件，不是独立程序）；
2. **一个 chat.deepseek.com 账号** —— 朗读音色是 DS 账号级功能，没账号没有音色；
3. 本机有 Edge 或 Chrome（`src/browser/page.ts` 会自动探测，探测的是 Windows 路径）。

```bash
# 1) 生成本包不提交的构建产物 lib/（.gitignore 忽略了 node_modules/ 与 lib/）
pnpm install && npm run link-sdk && npm run build

# 2) 把本包链接进你的 profile（dsh plugin 会把参数转交给 profile 目录里的 pnpm）
dsh plugin --profile web add link:/abs/path/to/dsh-ds-tts

# 3) 在 profile 的 cordis.patch.yml 追加一行（与其它第三方插件同款）
#    - insert:
#        - id: ds-tts
#          name: ds-tts

# 4) 重启并刷新
dsh web
```

> 第 2 步之后 `cordis.patch.yml` 通常已被自动并入，但**手写 profile 时需要自己补那一行**——
> 装配行的 `id` 必须等于包名（`ds-tts`），这是客户端 bundle 的加载契约。

跑起来之后：

1. 重启 `dsh web`（宿主半与客户端 bundle 都只在启动时装载），刷新页面；
2. 第一次朗读会自动拉起一个**专用浏览器**（`$DSH_HOME/ds-tts/browser`，端口 9222）——
   在这个窗口里登录一次 chat.deepseek.com（之后全自动）；
3. 点任意助手消息下的 🔊。首次要等投递 + 合成（数秒到数十秒），**相同文本第二次秒回**（内容寻址缓存）。

不想点界面？直接打接口（下一节）。

---

<a id="how"></a>
## 它是怎么工作的（以及为什么必须这样）

### 30 秒版（人话）

DS 官方的朗读接口**不接正文**。它只认一个 `message_id` —— 也就是"读你自己 DS 会话里的哪条消息"。

所以"我想读这段文字"这句话，在 DS 那边**没有直接的表达方式**。ds-tts 的绕法只有一条：
**先想办法把这段文字变成 DS 会话里的一条消息，再让官方接口去读那条消息。**

"把文字变成一条消息"需要调 DS 的对话接口，而那要过 PoW 计算 + Cloudflare + 浏览器 TLS 指纹三道关。
这三道关**我们一道都不碰** —— 交给一个真实的浏览器去做（页面自己就会算、就有指纹）。

于是整件事被切成两半：

| 谁 | 干什么 | 为什么是它 |
| --- | --- | --- |
| **真浏览器**（CDP 驱动） | 把文字投递成一条 DS 消息 | PoW / `cf_clearance` / TLS 指纹它全都有，我们零逆向 |
| **ds-tts 宿主进程**（Node 直连） | 取票 + wss 收 PCM + 拼成 WAV + 缓存 | 实测 Cloudflare 不拦非浏览器客户端，所以合成不必过浏览器 |
| **DSH Web GUI** | 播放 / 下载 / 存盘 | 就是你要的"网页端读" |

一句话：**用真浏览器解决"进不去"的问题，用 Node 解决"读得到"的问题。**

### 机制细节（作者原文，一字未改）

DS 官方朗读的合成协议是：

```
POST /api/v0/auth/ticket {scope:"tts"}        → 一次性 ticket（600s，只能用一次）
wss  /api/v0/chat/tts/?chat_session_id=..&message_id=..&ticket=..&mode=manual&format=pcm|opus
```

**请求里没有正文参数** —— 读哪段文字由服务端从**你自己 DS 会话**的消息里取。所以：

| 环节 | 谁来做 | 为什么 |
|---|---|---|
| 把待读文本变成 DS 会话里的一条消息 | **真实浏览器（CDP 驱动）** | 需要调 `POST /api/v0/chat/completion`，那要 DeepSeekHashV1 的 WASM PoW + Cloudflare `cf_clearance` + 浏览器 TLS 指纹。交给真浏览器，这三样全部由页面自己完成，我们一行都不碰 |
| 取票 + wss 合成 + PCM→WAV | **ds-tts 宿主进程（Node 直连）** | 实测 Cloudflare 不拦非浏览器客户端（`GET /chat/tts/voices` 从 Node 返回干净的 `{"code":40003,"msg":"INVALID_TOKEN"}`，无 `cf-mitigated`），所以合成不必经浏览器 |
| 播放 / 下载 / 存盘 | DSH Web GUI | 就是你要的「网页端读」 |

投递方式（**实测结论决定了默认值**）：

> **DS 官方 TTS 只接受「助手消息」。** 对同一条会话实测：助手消息 `code 0 / success`（627 帧 / 3,009,162 字节 / pcm / 62.69 秒），用户消息返回 **`code 6 / no_content`**（0 帧）。
> 也就是说 `user` 模式在当前服务端行为下**不可能成功**，唯一可行的是 `echo`。因此 `mode` 默认是 **`echo`**，不是 `auto` —— 默认 `auto` 会先试一次 user：白跑一轮，而且那条投递出去的用户消息会**永久留在你的会话里**。

- **`echo`（默认）**：投递一条「请原样输出以下文本，不要添加解释或格式」的用户消息 → DS 模型写回助手回复 → 朗读**那条助手回复**。这是"任意文本也想用 DS 官方音色"的固有代价：文本要先在 DS 那边被复述一遍（消耗一次网页端模型回复，并留下会话消息）。
- **`user`**：只试用户消息（实测返回 `no_content`），保留给"将来 DS 支持用户消息时"用。
- **`auto`**：先试 user 再降级 echo，用于**自我发现**；已知不可用时直接走 echo。

`echoVerify`（默认开）会校验取到的正文确实包含原文的首尾；拿不到正文时自动跳过校验，**拿到但不一致则失败**（宁可报错，也不静默朗读错内容）。长文本更容易在复述时走样 —— 报错信息会建议调小 `maxChars` 分段。

### 为什么音频 URL 要带 `?v=`

音频路由的响应头是 `cache-control: public, max-age=31536000, immutable`，而路径是按**内容哈希**固定的（`<textHash>.wav`）。重新生成会覆盖同一个文件 —— 如果 URL 不变，**浏览器会一直从自己的 HTTP 缓存里给你旧音频**，让人以为"重新生成没生效"。

所以版本令牌（DS 侧每次合成唯一的 `audio_id`，缺失时退到写入时间）进 URL：同一版 URL 稳定（缓存照旧有效），新一版 URL 必变（浏览器必然取新字节）。**一个文本一个槽位、永远保留最新一版**；想保留历史版本需要改成 `hash+nonce` 独立文件 + 清理策略（当前刻意没做，避免磁盘随点击次数无界增长）。

---

<a id="security"></a>
## 安全约定

这个插件要**驱动你的浏览器**、**碰你的 DS 账号**、**能写你的工作区**，所以边界必须写在明面上。

| 约定 | 具体是什么 | 在代码里 |
| --- | --- | --- |
| **`userToken` 不落盘** | 只在页面上下文里读出来当次使用，宿主不写进配置、不打日志 | 覆盖层文件刻意**不含任何凭据字段**（`src/config.ts` 顶部注释） |
| **仅回环 + 同源** | 每条路由先过 `isLoopbackRequest()`：`remoteAddress` 必须是 `127.0.0.1`/`::1`、`Host` 必须是回环主机名、`sec-fetch-site` 不能是 `cross-site`、带 `Origin` 时必须同源 | `src/routes.ts:86-106`，8 条路由全部走 `guard()` |
| **不对 LAN 暴露** | 本插件会驱动本机浏览器、能写工作区，绝不能对局域网开口子 | 同上；护栏照搬 `dsh-text-drop` 的成熟做法 |
| **不逆向、不伪装** | 不实现 PoW / `cf_clearance` / TLS 指纹伪装，用的是**真浏览器真行为** | `src/browser/`（CDP 驱动页面，不算哈希、不改指纹） |
| **不引 playwright / puppeteer** | CDP 由 `ws` 直连；`ws` 是**唯一非 SDK 运行时依赖**，构建时内联进 bundle | `package.json` `dependencies` + `src/browser/cdp.ts` |
| **导出文件名净化** | 去分隔符与非法字符，并且**纵深防御**地抹掉任何 `..` 序列（即使分隔符已被替换也不允许出现） | `src/routes.ts:147-155` `sanitizeName()` |
| **同源** | 音频、导出、配置读写都只服务本机页面；别的机器打不到 | 同护栏 |

**两条必须知道的副作用**（不是漏洞，是设计）：

1. **`POST /api/ds-tts/voice` 改的是你 DS 账号的音色** —— 官方「朗读音色」是账号级设置，
   点「同步到 DS 账号」会同时改写你 DS 账号里的音色。
2. **`echo` 模式会在你的 DS 账号里留下消息** —— 每条待读文本都会投递进专用会话，
   并消耗一次网页端模型回复。会话过长时用设置里的「重建朗读会话」。

---

<a id="evidence"></a>
## 已验证（实测记录，不是"应该能跑"）

| 环节 | 证据 |
|---|---|
| 账号放行 | `GET /chat/tts/voices` → `code 0`，4 个音色；`/auth/ticket` → `code 0`，ticket 600s |
| TTS 只接受助手消息 | 同一会话：助手消息 `code 0`（627 帧 / 3,009,162 B / 62.69s）；用户消息 `code 6 / no_content` |
| **端到端朗读 + 缓存** | 缓存元数据 `mode:echo`、`voice:mira`、`seconds:172.54`、`bytes:8,282,136`、`serverFormat:pcm`，带 DS 侧 `audioId`/`traceId`，且 `echoVerify` 通过 —— 即「CDP 投递 → 模型回显 → ticket+wss → PCM→WAV → 落盘」整条链路真的跑通过 |
| 登录检测 | 曾误判"未登录"：新标签页还在 `about:blank` 时读 `localStorage`（竞态）。修法是 `waitForOrigin` 等页面落在 DS 源且 `readyState=complete`；修后 `status` 报 `pageFound:true / loggedIn:true` |

<a id="recheck"></a>
### 本次复核（2026-10-07，README 改写时新跑的 —— 与上表是两批数据）

上表是**仓库作者的记录**；下面是**本次改写 README 时**在隔离实例上真跑出来的，两批不要混着读。

环境：lab profile（本机 `127.0.0.1:3081`，非主实例 3080），插件已装为 `ds-tts`；
`D:/developing/DSH-plugin/ds-tts` 与本仓库的 `src/engine.ts` sha256 一致（`4BB6B01A…A93D4`），
即**打 3081 等于打本仓库这份代码**。

**① 环境自查** —— `node scripts/tts-call.mjs --status --base http://127.0.0.1:3081`（节选）：

```console
{
  "ok": true,
  "browser": {
    "connected": true,
    "cdpUrl": "http://127.0.0.1:9222",
    "browserVersion": "Edg/154.0.4258.53",
    "pageUrl": "https://chat.deepseek.com/",
    "launched": true,
    "lastError": ""
  },
  "ds": {
    "pageFound": true,
    "loggedIn": true,
    "allowed": true,
    "lastProbe": { "code": 0, "msg": "可用，检测到 4 个音色", "at": 1789401649853 },
    "userModeSupported": null,
    "chatSessionId": "ff668a51-c858-4b08-8158-ecf2c4080f7f"
  },
  "queue": { "pending": 0, "active": false },
  "cache": { "files": 39, "bytes": 35212884, "hits": 0, "misses": 0 },
  "config": { "voice": "mira", "format": "pcm", "mode": "echo", "maxChars": 2000,
              "cdpPort": 9222, "autoLaunch": true, "echoVerify": true, "timeoutMs": 120000 }
}
```

`--status` **不会**触发浏览器自启（它只读状态），所以这条命令可以随时跑。

**② 真合成一次**（这是"文本进、音频出"的最小验证）：

```console
$ node scripts/tts-call.mjs "README 实测：这是 ds-tts 命令行调用的一次真实合成。" --base http://127.0.0.1:3081
ok  wav  272.0 KB  5.8 秒  新合成
音色 mira  模式 echo  版本 cf94d3a0-f12c-4155-a1bc-a463e3d61cee
url  http://127.0.0.1:3081/api/ds-tts/audio/74f853beeef85471.wav?v=cf94d3a0-f12c-4155-a1bc-a463e3d61cee
```

**③ 同文本再跑一次 → 缓存命中**（版本与路径都不变，说明内容寻址缓存真的在生效）：

```console
$ node scripts/tts-call.mjs "README 实测：这是 ds-tts 命令行调用的一次真实合成。" --base http://127.0.0.1:3081
ok  wav  272.0 KB  5.8 秒  缓存命中
音色 mira  模式 echo  版本 cf94d3a0-f12c-4155-a1bc-a463e3d61cee
url  http://127.0.0.1:3081/api/ds-tts/audio/74f853beeef85471.wav?v=cf94d3a0-f12c-4155-a1bc-a463e3d61cee
```

**④ 落盘 + 文件真伪**（`--out`，写到临时目录）：

```console
$ node scripts/tts-call.mjs "缓存命中也应该能落盘。" --out <临时目录>/out.wav --base http://127.0.0.1:3081
ok  wav  111.6 KB  2.4 秒  新合成
音色 mira  模式 echo  版本 b3f7f82e-dc7a-4763-9f90-5b6c85863240
url  http://127.0.0.1:3081/api/ds-tts/audio/1802f64a7c187ab8.wav?v=b3f7f82e-dc7a-4763-9f90-5b6c85863240
写出 <临时目录>\out.wav

文件大小 114266 B
前 12 字节 52 49 46 46 52 BE 01 00 57 41 56 45   → "RIFF" + "WAVE"
```

**⑤ `--regen` 强制重生成**（版本令牌变、路径不变 —— 正是「为什么音频 URL 要带 `?v=`」描述的行为）：

```console
$ node scripts/tts-call.mjs "缓存命中也应该能落盘。" --regen --base http://127.0.0.1:3081
ok  wav  111.6 KB  2.4 秒  重新生成
音色 mira  模式 echo  版本 9e0a9ecc-cf99-4b10-ace1-17f76683b36b
url  http://127.0.0.1:3081/api/ds-tts/audio/1802f64a7c187ab8.wav?v=9e0a9ecc-cf99-4b10-ace1-17f76683b36b
```

**⑥ 单测**（`node --test`，113 个用例全过）：

```console
$ node --test
ℹ tests 113
ℹ suites 0
ℹ pass 113
ℹ fail 0
ℹ duration_ms 602.4668
```

**本次没验证到的**（如实说，不含糊）：

- **完整 `npm run build` / `npm run typecheck` 没跑通**。两半 bundle 都产出成功
  （`host bundle written to lib/index.js` / `client bundle written to lib/client.js (id=ds-tts)`），
  但最后一步 `tsc -p tsconfig.build.json` 报
  `src/client/index.ts(13,36): error TS2307: Cannot find module '@deepseek-ai/dsh-client-runtime/client'`
  —— 本机所有候选位置都没有这个包的实体副本（profile 里是悬空 junction），离线补不齐。
  **不是代码问题，是这台机器缺一份 SDK 副本**；在有完整 dsh 安装的机器上按「开发」一节跑即可。
- **没有 GUI 截图**。本次没能稳定取到插件设置面板，也没有仓库自带素材，
  所以按降级规则用上面的终端实录代替 —— **不造示意图**。
- 没有验证非 Windows 平台（自动探测浏览器只写了 Windows 路径）。

---

<a id="http-api"></a>
## HTTP 接口

全部挂在 `/api/ds-tts` 下，**仅回环可调**（本机脚本可以，别的机器不行），本机调用**不需要鉴权** ——
上面那道护栏就是它的边界。默认端口取决于你的 DSH 实例（`dsh web` 默认 `3080`；本机 lab 实例是 `3081`）。

### 端点

| 名称 | 参数 | 说明 |
| --- | --- | --- |
| `POST /synthesize` | `{text, voice?, format?, mode?, regenerate?, sessionId?}` | 文本进、音频出。返回 `{ok, id, url, version, regenerated, ext, bytes, ms, cached, voice, mode, seconds, text, truncated}`。`text` 空 → 400；超长（`maxChars` 的 8 倍）→ 413 `TOO_LONG` |
| `GET /audio/<id>.<ext>` | 路径参数 `id`（16 位 hex）、`ext` ∈ `wav`/`mp3`/`opus`；`?v=<版本>` | 取音频字节。`?v=` **只用于缓存击穿，路由忽略它**；响应带 `immutable` 长缓存。id/ext 不合法 → 400；文件不在缓存（可能被清理）→ 404 |
| `POST /export` | `{id, ext, sessionId, fileName?}` | 把缓存里的音频写到**该会话工作区**的 `<cwd>/.dsh/tts/`，返回绝对路径。重名自动加 `-1`…（上限 1000 次尝试）。缺参 → 400；音频不在缓存 → 404 |
| `GET /voices` | `?force=1` 跳过 1 小时缓存 | DS 官方音色列表（含公开 CDN 试听地址）与账号当前音色 |
| `POST /voice` | `{voiceId}` | 切**账号级**音色（会改你 DS 账号里的设置）。`voiceId` 空 → 400 |
| `GET /status` | `?probe=1` 顺带真探测一次放行 | 浏览器 / 登录 / 放行 / 队列 / 缓存自查。**不会触发浏览器自启** |
| `GET`/`PUT`/`POST /config` | `PUT`/`POST` 的 body 是配置补丁 | 读 / 写生效配置。补丁字段走白名单（9 个 string + 4 个 number + 3 个 boolean），不认识 → 400 |
| `POST /cancel` | `{id?}` | 取消排队 / 进行中的合成；不带 id = 取消当前 |

> `/voices` 在 `autoLaunch:true` 时会顺手把专用浏览器拉起来（**有副作用**）——诊断请优先用 `/status`。

<a id="cli"></a>
### 命令行（`scripts/tts-call.mjs`）

不依赖插件内部代码，只打 HTTP —— 这也是「文本进音频出」不经 GUI 的最小示例：

| 名称 | 参数 | 说明 |
| --- | --- | --- |
| `node scripts/tts-call.mjs` | `<文字> [选项]` | 合成并打印 URL 与元数据；`ok / ext / KB / 秒数 / 新合成\|缓存命中\|重新生成` |
| `--voice` | `<id>` | 音色：`mira`（贝壳，默认）/ `echo`（白浪）/ `stella`（海星）/ `tide`（暗潮） |
| `--mode` | `<m>` | 投递模式：`echo`（默认）/ `auto` / `user` |
| `--regen` / `--regenerate` | — | 强制重新生成一版（跳过缓存） |
| `--out` / `-o` | `<路径>` | 把音频写到该文件；以分隔符结尾或没有扩展名则当目录 |
| `--json` | — | 只吐原始 JSON（不配 `--out` 时生效），方便脚本接 |
| `--base` | `<url>` | 宿主地址，默认 `http://127.0.0.1:3080` |
| `--status` | — | 查浏览器 / 登录 / 缓存状态后退出 |
| `--help` / `-h` | — | 打印用法 |

等价的手写请求：

```bash
curl -s -X POST http://127.0.0.1:3080/api/ds-tts/synthesize \
  -H 'Content-Type: application/json' \
  -d '{"text":"要朗读的文字","voice":"mira"}'
curl -s 'http://127.0.0.1:3080/api/ds-tts/audio/<id>.wav?v=<version>' -o out.wav
```

三条必须知道的事：

1. **仅回环可调**：路由带 loopback + 同源护栏（它要驱动本机浏览器、能写工作区）。本机脚本可以，别的机器不行。
2. **本机调用不需要鉴权**（实测裸 fetch 即 200）—— 上面那条护栏就是它的边界。
3. **合成要求 DS 专用浏览器在跑且已登录**（DS 官方 TTS 只读助手消息，文本必须先投递进会话）；**命中缓存时两者都不需要**。

<a id="tools"></a>
### 模型可见工具

三个工具都由宿主注册，模型可以直接调：

| 名称 | 参数 | 说明 |
| --- | --- | --- |
| `tts_speak` | `text`（必填）、`voice?`、`format?`（`pcm`/`opus`）、`out?`、`regenerate?`、`play?` | 合成并**落成真实文件**，返回绝对路径（可直接 `present`）。默认写 `$DSH_HOME/ds-tts/out/`。失败返回 `ok:false` + 中文 `error`，**不抛错**（一次 TTS 失败不该结束整个回合） |
| `tts_voices` | `refresh?` | 列音色 + 账号当前音色（`refresh:true` 跳缓存） |
| `tts_status` | 无 | 诊断：浏览器连通 / 是否登录 / 是否放行 / 队列 / 缓存。`tts_speak` 报错时先调它 |

### 接口清单与验证方式

| 层 | 接口 | 怎么确认它在 |
|---|---|---|
| 插件 | `synthesize` / `audio/<id>.<ext>` / `export` / `voices` / `voice` / `status` / `config` / `cancel` | 装配测试断言 **8/8** 注册；另用**无副作用调用**逐条实测：`status` 200、`config` 200、`synthesize` 空文本 400（不触发合成）、`cancel` 200、`export` 缺参 400、`audio` 坏 id 400、`audio` 真 id **200 + `audio/wav` + RIFF 头** |
| DS 官方 | `GET /api/v0/chat/tts/voices`、`POST /api/v0/auth/ticket`、`wss /api/v0/chat/tts/` | 实测：`code 0` / 4 个音色 / ticket 600s / 助手消息 627 帧 3,009,162 字节 |
| **不存在** | 「读任意文本」的接口；「读用户消息」的接口 | 用户消息实测 `code 6 / no_content`；官方 API Change Log 无 TTS 条目 |

> 诊断请优先用 `GET /api/ds-tts/status`：它**不会**触发浏览器自启。而 `/voices` 在 `autoLaunch:true` 时会顺手把专用浏览器拉起来（有副作用）。

---

<a id="config"></a>
## 配置

部署默认值在 `cordis.patch.yml` 的 `config:`（Schemastery），用户在 `$DSH_HOME/ds-tts/config.json` 的覆盖层按 mtime 热读（改完不需要重启）。

设置入口：**设置 → 通用 → 「语音朗读（ds-tts）」** —— 改音色/格式/投递模式/上限、看状态自查、重建朗读会话。

| 项 | 默认 | 说明 |
|---|---|---|
| `voice` | `mira` | 音色 voice_id |
| `format` | `pcm` | `pcm` → 无损 WAV；`opus` → 体积小（带 Ogg 容器且有 ffmpeg 时转 MP3） |
| `mode` | `echo` | 投递模式 `echo`（默认）/`user`/`auto` —— 见上文实测结论 |
| `maxChars` | `2000` | 归一化后上限；超出在句末截断并回 `truncated:true`；离谱超长（8×）回 413 `TOO_LONG` |
| `cdpUrl` / `cdpPort` | `''` / `9222` | CDP 端点（`cdpUrl` 非空则完全用它，不再自启） |
| `browserPath` / `userDataDir` | `''` | 留空自动探测 Edge/Chrome 与 `$DSH_HOME/ds-tts/browser` |
| `autoLaunch` | `true` | 没端点时是否自启专用浏览器 |
| `chatSessionId` | `''` | ds-tts 专用 DS 会话（首次投递时创建并记住） |
| `echoPrompt` / `echoVerify` | 见 schema | echo 模式指令模板与回显校验 |
| `timeoutMs` | `120000` | 单次合成总超时 |
| `cacheEnabled` / `cacheKeepDays` | `true` / `30` | 内容寻址缓存与保留期 |
| `ffplayPath` | `''` | 工具 `play:true` 时用的 ffplay |

---

<a id="storage"></a>
## 它把东西放在哪

```
$DSH_HOME/ds-tts/
  config.json      # 用户覆盖层（config）+ 运行时状态（runtime：lastProbe / voicesCache / chatSessionId）
  cache/           # 内容寻址缓存：<16 位 hex>.wav + 同名 .json 元数据
  browser/         # 专用浏览器 profile（要在这里登录一次 DS）
  out/             # tts_speak 工具的默认产物目录

<会话 cwd>/.dsh/tts/   # /export 路由的落点（带 sessionId，所以能解析会话工作区）
```

覆盖层按 **mtime 热读**：改 `config.json` 不需要重启 DSH。它**刻意不含任何凭据字段**（见「安全约定」）。

---

<a id="deps"></a>
## 依赖

运行期的 `@deepseek-ai/*` SDK **由 dsh 提供**（profile 的 `node_modules` 里就是 dsh 安装的 junction），所以它们**刻意不写进任何依赖字段**：

- 写进 `dependencies` 会拉进第二份副本，`@deepseek-ai/schemastery` 的 schema 身份、SlotMap 增补都可能对不上；
- 写进 `peerDependencies` 也不行 —— pnpm 会去 registry 解析，而 `@deepseek-ai/dsh-*` 的 rc 版存在 **semver 预发布区间问题**：它们的传递依赖写 `^0.1.5`，匹配不到 `0.1.5-rc.x`，直接 `ERR_PNPM_NO_MATCHING_VERSION`。标 `optional: true` 也拦不住。

所以：**committed 的配置里没有任何本机路径**，本地开发用 `npm run link-sdk` 把本机 dsh 安装里的 SDK 链接进来（见下）。真正起作用的运行期契约是 `package.json` 的 `dsh.client.inject` 与源码里的 import（plugin 行由 profile 装配，SDK 由宿主解析）。

> **口径提醒**：`.npmrc`、`scripts/link-sdk.mjs` 与 `package.json` 的 `dsh._note` 都说这些 SDK
> 「只声明为 peerDependencies」，但 `package.json` 里**并没有 `peerDependencies` 字段** ——
> 实际是**一个依赖字段都没进**。README 按实际字段叙述，源码未改。

---

<a id="dev"></a>
## 开发

```bash
pnpm install          # 只装普通依赖（esbuild / typescript / ws / @types / react），不需要访问私有 registry
npm run link-sdk      # ★ 必跑：把本机 dsh 安装里的 @deepseek-ai/* 链进 node_modules（供 tsc/esbuild 解析类型）
npm run typecheck     # tsc --noEmit
npm run build         # esbuild → lib/index.js + lib/client.js（+ lib/testing.js 给测试）；tsc -p tsconfig.build.json → lib/types
npm test              # build + node --test（113 个用例，默认不联网、不需要浏览器）
npm run probe         # Step 0 探针说明 + 宿主侧可达性检查
```

`link-sdk.mjs` 会扫描 `$DSH_HOME/profiles/node_modules/@deepseek-ai`、`profiles/web/...` 与 npm 全局的 dsh 安装，
把找到的包做成 junction（Windows 免管理员）；它**校验 `package.json` 是否存在**，所以会自动跳过本机那些**悬空 junction**（有目录、无 `package.json`）。也可用 `DSH_SDK_DIR` 直接指定 `@deepseek-ai` 所在目录。

`tsconfig.json` 开着 **`preserveSymlinks: true`**，这是必需的：TS 默认会穿透链接到真实路径，于是
`ui-chat` / `ui-conversation` 在自身位置向上解析 `@deepseek-ai/dsh-client-ui-slots` 时会命中 profile 里那个
**悬空 junction**，它们对 `SlotMap` 的 `declare module` 增补就被静默丢弃（症状：SlotMap 里只剩本插件自己声明的 key）。
开着它，解析停留在本仓库 `node_modules`（`link-sdk` 建立的那套），全部命中可用副本 —— 于是 committed 配置里不需要任何绝对路径。

<a id="codemap"></a>
### 代码地图

```
src/index.ts          宿主 apply：配置 + 路由 + 工具
src/engine.ts         编排：归一化 → 缓存 → 串行队列 → 浏览器投递 → ticket+wss → WAV/MP3
src/routes.ts         HTTP 层（护栏 / 状态码 / 导出落盘）
src/tools.ts          tts_speak / tts_voices / tts_status
src/config.ts         Schemastery 默认值 ⊕ config.json 热读覆盖层
src/ds/tts.ts         DS 官方通道（voices / voice / ticket / wss 收帧）
src/ds/frames.ts      4 字节大端 seq 帧、信封、业务码→中文
src/ds/history.ts     history_messages 的解释层（字段别名归一化 / 新消息选择 / 诊断）
src/ds/mode.ts        投递模式决策（实测：DS 只接受助手消息 → 为什么默认 echo）
src/ds/text.ts        Markdown → 口播文本归一化
src/browser/cdp.ts    极简 CDP 客户端（/json/list + 页级 WebSocket JSON-RPC）
src/browser/page.ts   页面驱动：就绪等待 / 选页复用 / 登录检测 / 投递 / 取 message_id
src/audio/*           裸 PCM→WAV、内容寻址缓存（含版本令牌）、可选 Ogg/Opus→MP3、ffplay 播放
src/client/*          Web GUI：slot 注册、播放器、弹窗、设置行、动作（朗读/重新生成/下载/存盘）
src/client/icons.tsx  图标：官方 primitives 图标（带存在性检查）+ DS 网页端原版朗读素材
src/client/primitives.d.ts  平台模块的类型 shim（本机没有实体，只有运行时模块表提供）
scripts/build-*.mjs   两半的 esbuild 构建
scripts/link-sdk.mjs  本地开发：把本机 dsh 安装的 @deepseek-ai/* 链进 node_modules
scripts/tts-call.mjs  命令行调 HTTP 接口的示例（不依赖插件内部）
scripts/probe*.mjs    Step 0 探针
docs/probe*.js        4 个**浏览器控制台**探针（F12 → Console 粘贴，不是 node 脚本；只读或合成，不发送消息）
test/*.test.mjs       12 个测试文件（node --test，113 个用例）
```

### 关于图标

官方图标来自平台模块 `@deepseek-ai/dsh-client-ui-primitives`（官方 bundle 里以
`_deepseek_ai_dsh_client_ui_primitives.X` 引用它）。播放条直接复用官方图标
（`IconPlayOutline16` / `IconPauseOutline16` / `IconStopFill16` / `IconLoadingOutline16` / `IconCloseOutline16`）；
官方图标集里**没有**声音与下载图标，所以 🔊 / ⤓ / 💾 三个按官方 16px 描边约定自绘
（`viewBox="0 0 16 16"`、`fill="none"`、`stroke="currentColor"`、`strokeWidth=1.31831`、圆角端点）。

> 该包在本机是**悬空 junction**（没有实体可读），所以类型是 shim、并在运行时做
> 存在性检查：任一图标拿不到就退到内联等价物，绝不让一个图标名把插件搞白屏。

---

<a id="troubleshoot"></a>
## 排障

<details>
<summary><b>报错怎么定位（先看 status 再看 mode）</b></summary>

1. `node scripts/tts-call.mjs --status` 或 `GET /api/ds-tts/status`（都**不会**触发浏览器自启）；
2. 按返回的字段对号入座：

| 症状 | 看哪个字段 | 大概率原因 |
| --- | --- | --- |
| 说浏览器不可用 | `browser.connected` / `lastError` | 专用浏览器没起、或 CDP 端口被别的进程占了 |
| 说没登录 | `ds.pageFound` vs `ds.loggedIn` | 页面没打开（`pageFound:false`）与没登录（`pageFound:true` 但 `loggedIn:false`）是**两件事** |
| 账号没放行 | `ds.allowed` / `lastProbe.code` | 账号没有官方朗读灰度 |
| 合成报 `DELIVER_FAILED` | — | DS 前端改版把投递选择器改了，需要适配 |
| 朗读出来的内容不对 | `echoVerify` | 复述走样；调小 `maxChars` 分段 |
| 点了"重新生成"没变化 | URL 里的 `?v=` | 浏览器缓存了旧字节 —— 正常路径下版本令牌会变，若没变说明没真的重生成 |

</details>

<details>
<summary><b>合成很慢 / 卡住</b></summary>

首次合成要：拉起浏览器 → 等页面 `readyState=complete`（最多 20s）→ 投递 → 等模型回显 → 取票 → wss 收 PCM。
`openPage` 超时会返回 `PAGE_NOT_READY`（**可重试**），而不是误报"未登录"。`timeoutMs` 默认 120s。
**命中缓存时纯读文件，不需要浏览器** —— 所以同文本第二次会秒回。

</details>

---

<a id="limits"></a>
## 已知限制

- 官方朗读是灰测/新功能接口，**协议随时可能变**；前端改版会让投递选择器失效（届时 `tts_status` 会给出 `DELIVER_FAILED`）。
- 每次未命中缓存的朗读都需要**专用浏览器在运行**；命中缓存时纯读文件，不需要浏览器。
- 选页策略是"复用优先"（有专用会话就复用该会话页，否则复用任何已开的 DS 页，都没有才新开），所以不会每失败一次就堆一个标签页；ds-tts **不会关闭**任何标签页。
- 冷启动浏览器/首次加载 DS 页面需要时间：`openPage` 会等页面真正落在 `chat.deepseek.com` 且 `readyState=complete`（最多 20s）才去读登录态，超时返回 `PAGE_NOT_READY`（可重试）而不是误报"未登录"。
- echo 模式每条文本都会在你的 DS 账号里留下会话消息，并消耗一次网页端模型回复；会话过长时可用设置里的「重建朗读会话」。
- 长文本按 `maxChars` 截断（并在 UI 提示）；不做整段对话拼接成单一长音频。
- 不做词级高亮同步。
- SAPI / Edge 等其它引擎**刻意没有**：这台机器上要的就是 DS 官方音色。
- **自动探测浏览器是 Windows 形状**（`src/browser/page.ts` 只拼 `msedge.exe` / `chrome.exe` 的 Windows 路径，
  且没有 `process.platform === 'win32'` 判断）。非 Windows 上要自己填 `browserPath`；**未在非 Windows 上验证过**。
- 一个文本一个缓存槽位、只保留最新一版（想留历史版本要改成 `hash+nonce` + 清理策略，当前刻意没做）。

---

<a id="license"></a>
## License

BSD-3-Clause —— 声明见 [`package.json`](package.json) 的 `license` 字段。

> 仓库根目录**没有 `LICENSE` 文件**（GitHub 也识别不到许可），所以这里不给徽章、不复制全文。

---

## 相关

- [awesome-dsh-plugin](https://github.com/liceses/awesome-dsh-plugin) —— DSH 插件精选列表。
