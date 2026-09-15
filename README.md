# ds-tts

在 DSH Web GUI 里用 **DeepSeek 官方朗读音色**朗读对话、导出音频，并提供「文本进、音频出」的接口与工具。

- 🔊 每条助手消息可一键朗读（DS 官方音色：贝壳 `mira` / 白浪 `echo` / 海星 `stella` / 暗潮 `tide`）
- ⟳ 每条消息可**重新生成**：DS 每次合成的声音可能不同，缓存会让同文本秒回同一版，所以需要显式再要一版
- ⤓ 导出为音频文件下载，或存进当前会话工作区 `.dsh/tts/`
- 输入框旁的朗读入口：粘贴任意文本即可播放 / 重新生成 / 下载 / 存盘
- HTTP 接口 `POST /api/ds-tts/synthesize`：文本进、音频 URL 与文件出（命令行示例见 `scripts/tts-call.mjs`）
- 三个模型可见工具：`tts_speak` / `tts_voices` / `tts_status`

## 已验证（实测记录，不是"应该能跑"）

| 环节 | 证据 |
|---|---|
| 账号放行 | `GET /chat/tts/voices` → `code 0`，4 个音色；`/auth/ticket` → `code 0`，ticket 600s |
| TTS 只接受助手消息 | 同一会话：助手消息 `code 0`（627 帧 / 3,009,162 B / 62.69s）；用户消息 `code 6 / no_content` |
| **端到端朗读 + 缓存** | 缓存元数据 `mode:echo`、`voice:mira`、`seconds:172.54`、`bytes:8,282,136`、`serverFormat:pcm`，带 DS 侧 `audioId`/`traceId`，且 `echoVerify` 通过 —— 即「CDP 投递 → 模型回显 → ticket+wss → PCM→WAV → 落盘」整条链路真的跑通过 |
| 登录检测 | 曾误判"未登录"：新标签页还在 `about:blank` 时读 `localStorage`（竞态）。修法是 `waitForDsOrigin` 等页面落在 DS 源且 `readyState=complete`；修后 `status` 报 `pageFound:true / loggedIn:true` |

## 它是怎么工作的（以及为什么必须这样）

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

## 安全约定

- **DS 的 `userToken` 不落盘**：只在页面上下文里读出来当次使用，宿主不写进配置、不打日志。
- 所有路径只在**仅回环 + 同源**时可用（照搬 `dsh-text-drop` 的护栏）：本插件会驱动本机浏览器并能写工作区，绝不能对 LAN 暴露。
- 不实现 PoW/`cf_clearance`/TLS 指纹伪装；用的是真浏览器真行为。
- 不引 playwright/puppeteer：CDP 由 `ws` 直连（唯一非 SDK 运行时依赖，构建时内联进 bundle）。

## 安装

```bash
# 1) 把本包链接进你的 web profile（dsh plugin 会把参数转交给 profile 目录里的 pnpm）
dsh plugin --profile web add link:/abs/path/to/dsh-ds-tts

# 2) 在 profile 的 cordis.patch.yml 追加一行（与其它第三方插件同款）
#    - insert:
#        - id: ds-tts
#          name: ds-tts

# 3) 重启并刷新
dsh web
```

本包**不提交 `lib/`**（构建产物），所以先 `npm install && npm run link-sdk && npm run build` 生成它，再让 dsh 加载；或者直接把构建好的目录链接进去。

## 首次使用

1. 重启 `dsh web`（宿主半与客户端 bundle 都只在启动时装载），刷新页面。
2. 第一次朗读会自动拉起一个**专用浏览器**（`$DSH_HOME/ds-tts/browser`，端口 9222）。
   在这个窗口里登录一次 chat.deepseek.com（之后全自动）。
3. 点任意助手消息下的 🔊。首次要等投递 + 合成（数秒到数十秒），**相同文本第二次秒回**（内容寻址缓存）。
   听腻了就点 **⟳ 重新生成** —— DS 每次合成的声音可能不同，缓存会让同文本秒回同一版，所以需要显式再要一版。

设置 → 通用 → 「语音朗读（ds-tts）」可以改音色/格式/投递模式/上限、看状态自查、重建朗读会话。

> ⚠️ 官方「朗读音色」是**账号级**设置：点「同步到 DS 账号」会同时改写你 DS 账号里的音色。

## 接口

| 方法/路径 | 说明 |
|---|---|
| `POST /api/ds-tts/synthesize` | `{text, voice?, format?, mode?, regenerate?, sessionId?}` → `{ok, id, url, version, regenerated, ext, bytes, ms, cached, voice, mode, seconds, text, truncated}` |
| `GET /api/ds-tts/audio/<id>.<ext>?v=<版本>` | 取音频字节（`id` = 16 位 hex，`ext` ∈ wav/mp3/opus；`?v=` 只用于缓存击穿，路由忽略它） |
| `POST /api/ds-tts/export` | `{id, ext, sessionId, fileName?}` → 写到 `<cwd>/.dsh/tts/`，返回绝对路径 |
| `GET /api/ds-tts/voices` | DS 官方音色（含公开 CDN 试听地址） |
| `POST /api/ds-tts/voice` | `{voiceId}` 切账号级音色 |
| `GET /api/ds-tts/status` | 浏览器/登录/放行/队列/缓存自查（`?probe=1` 顺带真探测） |
| `GET`/`PUT /api/ds-tts/config` | 读写生效配置 |
| `POST /api/ds-tts/cancel` | `{id?}` 取消排队/进行中的合成 |

### 直接用命令行调（`scripts/tts-call.mjs`）

不依赖插件内部代码，只打 HTTP —— 这也是「文本进音频出」不经 GUI 的最小示例：

```bash
node scripts/tts-call.mjs "要朗读的文字"                 # 打印 URL 与元数据
node scripts/tts-call.mjs "文字" --voice tide --out out.wav
node scripts/tts-call.mjs "文字" --regen                 # 强制重新合成一版
node scripts/tts-call.mjs --status                       # 看浏览器/登录/缓存是否就绪
```

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

### 为什么音频 URL 要带 `?v=`

音频路由的响应头是 `cache-control: public, max-age=31536000, immutable`，而路径是按**内容哈希**固定的（`<textHash>.wav`）。重新生成会覆盖同一个文件 —— 如果 URL 不变，**浏览器会一直从自己的 HTTP 缓存里给你旧音频**，让人以为"重新生成没生效"。

所以版本令牌（DS 侧每次合成唯一的 `audio_id`，缺失时退到写入时间）进 URL：同一版 URL 稳定（缓存照旧有效），新一版 URL 必变（浏览器必然取新字节）。**一个文本一个槽位、永远保留最新一版**；想保留历史版本需要改成 `hash+nonce` 独立文件 + 清理策略（当前刻意没做，避免磁盘随点击次数无界增长）。

### 接口清单与验证方式

| 层 | 接口 | 怎么确认它在 |
|---|---|---|
| 插件 | `synthesize` / `audio/<id>.<ext>` / `export` / `voices` / `voice` / `status` / `config` / `cancel` | 装配测试断言 **8/8** 注册；另用**无副作用调用**逐条实测：`status` 200、`config` 200、`synthesize` 空文本 400（不触发合成）、`cancel` 200、`export` 缺参 400、`audio` 坏 id 400、`audio` 真 id **200 + `audio/wav` + RIFF 头** |
| DS 官方 | `GET /api/v0/chat/tts/voices`、`POST /api/v0/auth/ticket`、`wss /api/v0/chat/tts/` | 实测：`code 0` / 4 个音色 / ticket 600s / 助手消息 627 帧 3,009,162 字节 |
| **不存在** | 「读任意文本」的接口；「读用户消息」的接口 | 用户消息实测 `code 6 / no_content`；官方 API Change Log 无 TTS 条目 |

> 诊断请优先用 `GET /api/ds-tts/status`：它**不会**触发浏览器自启。而 `/voices` 在 `autoLaunch:true` 时会顺手把专用浏览器拉起来（有副作用）。

## 配置

部署默认值在 `cordis.patch.yml` 的 `config:`（Schemastery），用户在 `$DSH_HOME/ds-tts/config.json` 的覆盖层按 mtime 热读（改完不需要重启）。

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

## 依赖

运行期的 `@deepseek-ai/*` SDK **由 dsh 提供**（profile 的 `node_modules` 里就是 dsh 安装的 junction），所以它们**刻意不写进任何依赖字段**：

- 写进 `dependencies` 会拉进第二份副本，`@deepseek-ai/schemastery` 的 schema 身份、SlotMap 增补都可能对不上；
- 写进 `peerDependencies` 也不行 —— pnpm 会去 registry 解析，而 `@deepseek-ai/dsh-*` 的 rc 版存在 **semver 预发布区间问题**：它们的传递依赖写 `^0.1.5`，匹配不到 `0.1.5-rc.x`，直接 `ERR_PNPM_NO_MATCHING_VERSION`。标 `optional: true` 也拦不住。

所以：**committed 的配置里没有任何本机路径**，本地开发用 `npm run link-sdk` 把本机 dsh 安装里的 SDK 链接进来（见下）。真正起作用的运行期契约是 `package.json` 的 `dsh.client.inject` 与源码里的 import（plugin 行由 profile 装配，SDK 由宿主解析）。

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
```

### 关于图标

官方图标来自平台模块 `@deepseek-ai/dsh-client-ui-primitives`（官方 bundle 里以
`_deepseek_ai_dsh_client_ui_primitives.X` 引用它）。播放条直接复用官方图标
（`IconPlayOutline16` / `IconPauseOutline16` / `IconStopFill16` / `IconLoadingOutline16` / `IconCloseOutline16`）；
官方图标集里**没有**声音与下载图标，所以 🔊 / ⤓ / 💾 三个按官方 16px 描边约定自绘
（`viewBox="0 0 16 16"`、`fill="none"`、`stroke="currentColor"`、`strokeWidth=1.31831`、圆角端点）。

> 该包在本机是**悬空 junction**（没有实体可读），所以类型是 shim、并在运行时做
> 存在性检查：任一图标拿不到就退到内联等价物，绝不让一个图标名把插件搞白屏。

## 已知限制

- 官方朗读是灰测/新功能接口，**协议随时可能变**；前端改版会让投递选择器失效（届时 `tts_status` 会给出 `DELIVER_FAILED`）。
- 每次未命中缓存的朗读都需要**专用浏览器在运行**；命中缓存时纯读文件，不需要浏览器。
- 选页策略是"复用优先"（有专用会话就复用该会话页，否则复用任何已开的 DS 页，都没有才新开），所以不会每失败一次就堆一个标签页；ds-tts **不会关闭**任何标签页。
- 冷启动浏览器/首次加载 DS 页面需要时间：`openPage` 会等页面真正落在 `chat.deepseek.com` 且 `readyState=complete`（最多 20s）才去读登录态，超时返回 `PAGE_NOT_READY`（可重试）而不是误报"未登录"。
- echo 模式每条文本都会在你的 DS 账号里留下会话消息，并消耗一次网页端模型回复；会话过长时可用设置里的「重建朗读会话」。
- 长文本按 `maxChars` 截断（并在 UI 提示）；不做整段对话拼接成单一长音频。
- 不做词级高亮同步。
- SAPI / Edge 等其它引擎**刻意没有**：这台机器上要的就是 DS 官方音色。

## License

BSD-3-Clause
