/**
 * ds-tts 双面共享的线上契约（纯类型 + 常量，浏览器半与宿主半都 import）。
 *
 * 这里刻意不 import config.ts / schemastery：浏览器半只需要这些类型，
 * 让它可以完全静态擦除，不把宿主依赖带进 client bundle。
 */

/** DS 官方朗读的合成音频形态。pcm = 24kHz 单声道 s16le；opus = 裸 Opus 包。 */
export type DsTtsFormat = 'pcm' | 'opus'

/**
 * 文本投递模式。
 * - `user`：把文本作为一条**用户消息**发进 DS 会话，再朗读那条消息（文本 100% 精确）。
 * - `echo`：投递一条"请原样输出以下文本"的指令，朗读 DS 模型的那条**助手回复**。
 *   官方 UI 只在助手回答下给朗读入口，所以 user 模式不被服务端接受时用它兜底。
 * - `auto`：先试 user，失败则自动降级 echo 并记住结论。
 */
export type DsTtsMode = 'auto' | 'user' | 'echo'

/** 实际生效的投递模式（auto 解析之后）。 */
export type DsTtsResolvedMode = 'user' | 'echo'

/** 结构化错误码（前端据此给中文文案，不靠字符串匹配）。 */
export type DsTtsErrorCode =
  | 'FORBIDDEN'
  | 'BAD_REQUEST'
  | 'TOO_LONG'
  | 'NO_BROWSER'
  /** 页面已连上但还没落在 chat.deepseek.com 且加载完成（可重试）。 */
  | 'PAGE_NOT_READY'
  | 'NOT_LOGGED_IN'
  | 'DELIVER_FAILED'
  | 'MESSAGE_NOT_FOUND'
  | 'TICKET_FAILED'
  | 'DS_NOT_AVAILABLE'
  | 'DS_FORBIDDEN'
  | 'DS_QUOTA'
  | 'DS_RATE_LIMIT'
  | 'NO_CONTENT'
  | 'UNSUPPORTED_LANGUAGE'
  | 'VOICE_UNSUPPORTED_LANGUAGE'
  | 'CONTENT_FILTER'
  | 'SYNTH_FAILED'
  | 'CACHE_WRITE_FAILED'
  | 'CANCELLED'
  | 'INTERNAL'

/** 音色信息（来自 DS 官方 `GET /api/v0/chat/tts/voices`）。 */
export interface DsTtsVoice {
  /** voice_id，例如 mira / echo / stella / tide。 */
  id: string
  /** 中文名（贝壳 / 白浪 / 海星 / 暗潮）。 */
  name: string
  /** female / male，未知时为空串。 */
  gender: string
  /** 描述，例如"百变活泼"。 */
  description: string
  /** 支持的语言码；空数组表示服务端未给。 */
  languages: readonly string[]
  /** 是否为服务端默认音色。 */
  isDefault: boolean
  /** 语言码 → 官方公开 CDN 试听 mp3（免 token 免合成）。 */
  demoUrls: Readonly<Record<string, string>>
}

/** 生效配置的只读视图（宿主配置 + $DSH_HOME/ds-tts.json 覆盖层的结果）。 */
export interface DsTtsConfigView {
  /** 朗读音色 voice_id。 */
  voice: string
  /** 合成格式。 */
  format: DsTtsFormat
  /** 投递模式。 */
  mode: DsTtsMode
  /** 单次合成文本上限（超限返回 TOO_LONG）。 */
  maxChars: number
  /** CDP 端点覆盖；空串 = 自动探测 127.0.0.1:<cdpPort>。 */
  cdpUrl: string
  /** CDP 端口（自动探测/自启专用浏览器时使用）。 */
  cdpPort: number
  /** 浏览器可执行文件路径；空串 = 自动探测 Edge/Chrome。 */
  browserPath: string
  /** 专用浏览器 profile 目录；空串 = $DSH_HOME/ds-tts/browser。 */
  userDataDir: string
  /** 没有可用 CDP 时是否自动拉起专用浏览器。 */
  autoLaunch: boolean
  /** ds-tts 专用 DS 会话 id；空串 = 首次投递时创建并记住。 */
  chatSessionId: string
  /** echo 模式的指令模板，`{text}` 会被替换为待读文本。 */
  echoPrompt: string
  /** echo 模式是否校验回显文本与原文一致（默认开，防止读错内容）。 */
  echoVerify: boolean
  /** 单次合成的总超时（毫秒）。 */
  timeoutMs: number
  /** 是否启用内容寻址缓存。 */
  cacheEnabled: boolean
  /** 缓存保留天数。 */
  cacheKeepDays: number
  /** ffplay 路径；空串 = 用 PATH 上的 ffplay。 */
  ffplayPath: string
}

/** 用户可改的配置补丁（PUT /config 的请求体）。 */
export type DsTtsConfigPatch = Partial<DsTtsConfigView>

/* ─────────────────────────── 路由：synthesize ─────────────────────────── */

export interface SynthesizeRequest {
  /** 待朗读文本（宿主会做 Markdown/长文归一化）。 */
  text: string
  /** 发起会话的 id，用于把导出落到该会话工作区（可选）。 */
  sessionId?: string
  /** 覆盖配置里的音色。 */
  voice?: string
  /** 覆盖配置里的合成格式。 */
  format?: DsTtsFormat
  /** 覆盖配置里的投递模式。 */
  mode?: DsTtsMode
  /**
   * 强制重新合成（跳过缓存读取）。
   *
   * 为什么需要它：DS 官方 TTS 每次合成**可能给出不同的声音**，而同文本默认走内容寻址缓存
   * （为了秒回）。想再要一版就必须显式要求重新生成。
   *
   * 语义：仍然写回**同一个**内容寻址槽位（覆盖旧那一版），并用新的 `audioId` 当 URL 版本令牌
   * —— 这样磁盘不会随点击次数无界增长，同时浏览器也一定会取到新字节。
   */
  regenerate?: boolean
}

export interface SynthesizeOk {
  ok: true
  /** 内容寻址 id（16 hex），audio 路由与 export 都用它。 */
  id: string
  /** 可直接给 <audio src> 用的同源 URL（带 `?v=<版本>`）。 */
  url: string
  /**
   * 音频版本令牌（DS 侧 `audio_id`，缺失时退到写入时间）。
   *
   * 它出现在 `url` 的 `?v=` 上，作用只有一个：音频路由的响应头是
   * `immutable, max-age=31536000`，而 URL 按内容哈希固定 —— 重新生成会覆盖同一个文件，
   * 若 URL 不变，**浏览器会一直给你旧的 HTTP 缓存**，让人误以为"重新生成没生效"。
   */
  version: string
  /** 本次是否是调用方显式要求的重新生成。 */
  regenerated: boolean
  /** 文件扩展名：wav / mp3 / opus。 */
  ext: string
  /** 音频字节数。 */
  bytes: number
  /** 本次耗时毫秒（命中缓存时很小）。 */
  ms: number
  /** 是否命中缓存（true 表示没有重新投递/合成）。 */
  cached: boolean
  /** 实际使用的音色。 */
  voice: string
  /** 实际使用的投递模式。 */
  mode: DsTtsResolvedMode
  /** 音频时长（秒，按采样率估算）。 */
  seconds: number
  /** 归一化后实际朗读的文本（前端可用于显示/诊断）。 */
  text: string
  /** 归一化时是否因超长被截断。 */
  truncated: boolean
}

export interface SynthesizeError {
  ok: false
  code: DsTtsErrorCode
  /** 面向用户的中文原因。 */
  error: string
  /** 诊断细节（trace id、原始 msg、页面选择器等）。 */
  detail?: string
}

export type SynthesizeResult = SynthesizeOk | SynthesizeError

/* ───────────────────────────── 路由：audio ───────────────────────────── */

/** audio 路由的 id 形态校验（内容寻址 id）。 */
export const AUDIO_ID_PATTERN = /^[0-9a-f]{16}$/
/** audio 路由允许的扩展名。 */
export const AUDIO_EXTS = ['wav', 'mp3', 'opus'] as const
export type AudioExt = (typeof AUDIO_EXTS)[number]

/* ───────────────────────────── 路由：export ──────────────────────────── */

export interface ExportRequest {
  id: string
  ext: string
  /** 目标会话 id：决定导出到哪个工作区。 */
  sessionId: string
  /** 覆盖文件名（会做净化与去重）。 */
  fileName?: string
}

export interface ExportOk {
  ok: true
  /** 导出后的绝对路径。 */
  path: string
  /** 实际使用的文件名。 */
  name: string
}

export type ExportResult = ExportOk | SynthesizeError

/* ───────────────────────────── 路由：voices ──────────────────────────── */

export interface VoicesOk {
  ok: true
  voices: DsTtsVoice[]
  /** 账号当前朗读音色。 */
  currentVoiceId: string | null
  /** 是否来自短时缓存。 */
  cached: boolean
}

export type VoicesResult = VoicesOk | SynthesizeError

export interface SetVoiceRequest {
  voiceId: string
}

export interface SetVoiceOk {
  ok: true
  voiceId: string
  /** 提示用户这次切换改写的是 DS 账号级设置。 */
  note: string
}

export type SetVoiceResult = SetVoiceOk | SynthesizeError

/* ───────────────────────────── 路由：status ──────────────────────────── */

export interface StatusResult {
  ok: true
  browser: {
    connected: boolean
    /** 实际使用的 CDP HTTP 端点；未连接时为空串。 */
    cdpUrl: string
    /** 浏览器 product 字符串，例如 "Edg/131.0.2903.86"。 */
    browserVersion: string
    /** 当前操作的页面 URL。 */
    pageUrl: string
    /** 是否是 ds-tts 自己拉起的专用浏览器。 */
    launched: boolean
    /** 最近一次失败原因。 */
    lastError: string
  }
  ds: {
    /** 浏览器里是否已经打开了 DS 页面。与"是否登录"是两件事，分开报才不会误导。 */
    pageFound: boolean
    /** 页面里是否存在 localStorage.userToken。仅在 pageFound 为真时有意义。 */
    loggedIn: boolean
    /** 最近一次探测到的服务端放行情况。 */
    allowed: boolean | null
    /** 最近一次探测到的 biz_code/biz_msg。 */
    lastProbe: { code: number; msg: string; at: number } | null
    /** 已验证可用的投递模式（null = 尚未验证）。 */
    userModeSupported: boolean | null
    /** ds-tts 专用会话 id。 */
    chatSessionId: string
  }
  queue: {
    /** 排队中的任务数。 */
    pending: number
    /** 是否有任务正在执行。 */
    active: boolean
  }
  cache: {
    files: number
    bytes: number
    hits: number
    misses: number
  }
  config: DsTtsConfigView
}

/* ───────────────────────────── 路由：cancel ──────────────────────────── */

export interface CancelRequest {
  /** 指定要取消的合成 id；缺省取消当前所有排队/进行中的任务。 */
  id?: string
}

export interface CancelOk {
  ok: true
  cancelled: number
}

export type CancelResult = CancelOk | SynthesizeError

/* ───────────────────────────── 常量 ──────────────────────────────────── */

/** DS 网页侧账号级"朗读音色"接口可用的官方 voice_id（用于前端兜底展示）。 */
export const KNOWN_DS_VOICES: readonly { id: string; name: string; gender: string; description: string }[] = [
  { id: 'mira', name: '贝壳', gender: 'female', description: '百变活泼' },
  { id: 'echo', name: '白浪', gender: 'male', description: '明朗坚定' },
  { id: 'stella', name: '海星', gender: 'female', description: '俏皮甜美' },
  { id: 'tide', name: '暗潮', gender: 'male', description: '低沉浑厚' },
]
