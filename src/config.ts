/**
 * 配置：Schemastery 部署默认值 ⊕ `$DSH_HOME/ds-tts/config.json` 用户覆盖层。
 *
 * 覆盖层按 mtime 热读，所以改 JSON 不需要重启 DSH。
 * 刻意**不含任何凭据字段**：DS 的 userToken 只在 CDP 页面上下文里读、即用即弃，
 * 永不落盘（见 browser/page.ts）。
 */
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { DsTtsConfigPatch, DsTtsConfigView, DsTtsFormat, DsTtsMode } from './protocol.ts'
import { configFilePath } from './paths.ts'

/** Schemastery 配置 schema（部署层默认值）。 */
export const Config = z.object({
  voice: z.string().default('mira').description('DS 朗读音色 voice_id（mira/echo/stella/tide）'),
  format: z.string().default('pcm').description("合成格式：'pcm'（落地为无损 WAV）或 'opus'（体积小）"),
  mode: z
    .string()
    .default('echo')
    .description(
      "投递模式：'echo'（默认，投递「请原样输出…」后朗读模型的助手回复，DS 只允许朗读助手消息）；'user'（只试用户消息，实测 DS 返回 no_content）；'auto'（先试 user 再降级 echo，用于将来 DS 支持用户消息时自我发现）",
    ),
  maxChars: z.number().min(50).max(20000).default(2000).description('单次合成文本上限（归一化后计）'),
  cdpUrl: z.string().default('').description('CDP 端点覆盖，留空=自动探测 127.0.0.1:<cdpPort>'),
  cdpPort: z.number().min(1).max(65535).default(9222).description('CDP 端口'),
  browserPath: z.string().default('').description('浏览器可执行文件路径，留空=自动探测 Edge/Chrome'),
  userDataDir: z.string().default('').description('专用浏览器 profile 目录，留空=$DSH_HOME/ds-tts/browser'),
  autoLaunch: z.boolean().default(true).description('无可用 CDP 时是否自动拉起专用浏览器'),
  chatSessionId: z.string().default('').description('ds-tts 专用 DS 会话 id，留空=首次投递时创建并记住'),
  echoPrompt: z
    .string()
    .default('请原样输出下面这段文本，不要添加任何解释、标题、序号或 Markdown 格式，也不要翻译：\n\n{text}')
    .description('echo 模式投递的指令模板，{text} 会被替换为待读文本'),
  echoVerify: z.boolean().default(true).description('是否校验要朗读的正文与预期文本一致（历史未返回正文时自动跳过；建议保持开启）'),
  timeoutMs: z.number().min(5000).max(600000).default(120000).description('单次合成总超时（毫秒）'),
  cacheEnabled: z.boolean().default(true).description('是否启用内容寻址缓存'),
  cacheKeepDays: z.number().min(0).max(3650).default(30).description('缓存保留天数，0=不自动清理'),
  ffplayPath: z.string().default('').description('ffplay 路径，留空=用 PATH 上的 ffplay'),
})

/** 校验后的配置对象类型（宿主 apply 的第二个参数）。 */
export type Config = ReturnType<typeof Config>

/** 覆盖层里由插件自己维护的运行时状态（不是用户配置）。 */
export interface DsTtsRuntimeState {
  /** user 模式是否已被验证可用；null = 尚未验证。 */
  userModeSupported: boolean | null
  /** ds-tts 专用 DS 会话 id（投递时创建，随后记住）。 */
  chatSessionId: string
  /** 最近一次服务端放行探测结果。 */
  lastProbe: { code: number; msg: string; at: number } | null
  /** 最近一次音色列表（避免每次打开设置页都打 DS）。 */
  voicesCache: { at: number; currentVoiceId: string; voices: unknown[] } | null
}

/** 覆盖层文件结构。 */
interface OverlayFile {
  config?: DsTtsConfigPatch
  runtime?: Partial<DsTtsRuntimeState>
}

/** 把任意字符串收敛到合法 format。 */
function normalizeFormat(value: unknown, fallback: DsTtsFormat): DsTtsFormat {
  return value === 'opus' || value === 'pcm' ? value : fallback
}

/** 把任意字符串收敛到合法 mode。 */
function normalizeMode(value: unknown, fallback: DsTtsMode): DsTtsMode {
  return value === 'user' || value === 'echo' || value === 'auto' ? value : fallback
}

/**
 * 把 host 半的 schemastery 输出规整成双面共享的只读视图。
 * @param cfg - schemastery 校验后的配置。
 * @returns 规整后的视图（枚举收敛、数值夹紧）。
 */
export function toView(cfg: Config): DsTtsConfigView {
  return {
    voice: typeof cfg.voice === 'string' && cfg.voice !== '' ? cfg.voice : 'mira',
    format: normalizeFormat(cfg.format, 'pcm'),
    mode: normalizeMode(cfg.mode, 'auto'),
    maxChars: Math.min(20000, Math.max(50, Math.round(cfg.maxChars))),
    cdpUrl: cfg.cdpUrl,
    cdpPort: Math.min(65535, Math.max(1, Math.round(cfg.cdpPort))),
    browserPath: cfg.browserPath,
    userDataDir: cfg.userDataDir,
    autoLaunch: cfg.autoLaunch,
    chatSessionId: cfg.chatSessionId,
    echoPrompt: cfg.echoPrompt,
    echoVerify: cfg.echoVerify,
    timeoutMs: Math.min(600000, Math.max(5000, Math.round(cfg.timeoutMs))),
    cacheEnabled: cfg.cacheEnabled,
    cacheKeepDays: Math.max(0, Math.round(cfg.cacheKeepDays)),
    ffplayPath: cfg.ffplayPath,
  }
}

/**
 * 配置存储：部署默认值 + 覆盖层文件（热读）+ 运行时状态。
 *
 * 生效值 = 部署默认值 ⊕ 覆盖层 `config`；运行时状态单独存放，不会被用户补丁覆盖。
 */
export class ConfigStore {
  private readonly base: Config
  private overlay: OverlayFile = {}
  private overlayMtimeMs = -1
  private loaded = false

  /**
   * @param base - schemastery 校验后的部署配置。
   */
  constructor(base: Config) {
    this.base = base
  }

  /** 覆盖层文件路径。 */
  get filePath(): string {
    return configFilePath()
  }

  /** 立刻加载一次（失败时保持空覆盖层，不阻断插件）。 */
  async load(): Promise<void> {
    await this.refresh()
    this.loaded = true
  }

  /** 是否已完成首次加载。 */
  get isLoaded(): boolean {
    return this.loaded
  }

  /** 按 mtime 增量读取覆盖层。 */
  private async refresh(): Promise<void> {
    let mtimeMs = -1
    try {
      mtimeMs = (await stat(this.filePath)).mtimeMs
    } catch {
      // 文件不存在 = 没有覆盖层
    }
    if (mtimeMs === this.overlayMtimeMs) return
    this.overlayMtimeMs = mtimeMs
    if (mtimeMs < 0) {
      this.overlay = {}
      return
    }
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'))
      this.overlay = typeof parsed === 'object' && parsed !== null ? (parsed as OverlayFile) : {}
    } catch {
      // 坏 JSON：忽略覆盖层，保留默认值（不抛，避免整个插件挂掉）
      this.overlay = {}
    }
  }

  /** 压入覆盖层并返回生效配置。 */
  private applyOverlay(): DsTtsConfigView {
    const merged = { ...toView(this.base), ...(this.overlay.config ?? {}) }
    return {
      ...merged,
      format: normalizeFormat(merged.format, 'pcm'),
      mode: normalizeMode(merged.mode, 'auto'),
      maxChars: Math.min(20000, Math.max(50, Math.round(merged.maxChars))),
      cdpPort: Math.min(65535, Math.max(1, Math.round(merged.cdpPort))),
      timeoutMs: Math.min(600000, Math.max(5000, Math.round(merged.timeoutMs))),
      cacheKeepDays: Math.max(0, Math.round(merged.cacheKeepDays)),
    }
  }

  /**
   * 读生效配置（必要时先做一次 mtime 检查）。
   * @returns 生效配置视图。
   */
  async view(): Promise<DsTtsConfigView> {
    await this.refresh()
    return this.applyOverlay()
  }

  /** 同步读最近一次生效配置（未加载时用部署默认值）。 */
  current(): DsTtsConfigView {
    return this.applyOverlay()
  }

  /**
   * 写入用户配置补丁（只允许 DsTtsConfigView 的字段）。
   * @param patch - 部分配置。
   * @returns 写入后的生效配置。
   */
  async patch(patch: DsTtsConfigPatch): Promise<DsTtsConfigView> {
    await this.refresh()
    const nextConfig: DsTtsConfigPatch = { ...(this.overlay.config ?? {}) }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      ;(nextConfig as Record<string, unknown>)[key] = value
    }
    await this.write({ ...this.overlay, config: nextConfig })
    return this.applyOverlay()
  }

  /** 读运行时状态。 */
  async runtime(): Promise<DsTtsRuntimeState> {
    await this.refresh()
    const r = this.overlay.runtime ?? {}
    return {
      userModeSupported: r.userModeSupported ?? null,
      chatSessionId: r.chatSessionId ?? '',
      lastProbe: r.lastProbe ?? null,
      voicesCache: (r.voicesCache as DsTtsRuntimeState['voicesCache']) ?? null,
    }
  }

  /**
   * 合并写运行时状态。
   * @param patch - 部分运行时状态。
   */
  async setRuntime(patch: Partial<DsTtsRuntimeState>): Promise<void> {
    await this.refresh()
    await this.write({ ...this.overlay, runtime: { ...(this.overlay.runtime ?? {}), ...patch } })
  }

  /** 原子写覆盖层文件（先写临时文件再 rename）。 */
  private async write(next: OverlayFile): Promise<void> {
    const target = this.filePath
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.tmp-${process.pid.toString()}`
    await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    await rename(tmp, target)
    this.overlay = next
    try {
      this.overlayMtimeMs = (await stat(target)).mtimeMs
    } catch {
      this.overlayMtimeMs = -1
    }
  }
}
