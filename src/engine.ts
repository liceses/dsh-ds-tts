/**
 * 合成编排引擎。
 *
 * 一条文本要走完的路：
 *   归一化 → 缓存查命中 →（串行队列）确保浏览器 → 选/开专用 DS 页面 → 读 token（仅内存）
 *   → 投递文本（优先 user 模式；不被服务端接受则自动降级 echo 模式并记住结论）
 *   → 取 message_id → ticket + wss 合成 → PCM→WAV（或 Ogg/Opus→MP3）→ 写缓存
 *
 * 关键不变量：
 * - **单飞**：只有一套浏览器会话，所有合成串行排队，避免并发投递互相污染。
 * - **缓存优先**：命中缓存绝不碰浏览器（所以浏览器关着也能重播已朗读过的内容）。
 * - **凭据不落盘**：token 由 `takeToken()` 从页面读出、当次用完即弃。
 * - **失败不撒谎**：任何阶段失败都返回结构化错误码，不做静默降级。
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ConfigStore } from './config.ts'
import type {
  CancelResult,
  DsTtsConfigView,
  DsTtsErrorCode,
  DsTtsFormat,
  DsTtsResolvedMode,
  DsTtsVoice,
  SetVoiceResult,
  StatusResult,
  SynthesizeError,
  SynthesizeRequest,
  SynthesizeResult,
  VoicesResult,
} from './protocol.ts'
import { cacheDirPath } from './paths.ts'
import { audioUrlWithVersion, audioVersion, cacheId, cacheStats, pruneCache, readCache, shouldReadCache, writeCache, type CacheMeta } from './audio/cache.ts'
import { pcmDurationSeconds, pcmToWav, wavDurationSeconds } from './audio/wav.ts'
import { encodeOggToMp3, findFfmpeg, isOggContainer } from './audio/convert.ts'
import { normalizeForSpeech } from './ds/text.ts'
import { RETRY_AS_ECHO_CODES } from './ds/frames.ts'
import { resolveAttemptOrder } from './ds/mode.ts'
import { fetchVoices, setVoice as dsSetVoice, synthFromMessage, type SynthAudio } from './ds/tts.ts'
import {
  attach,
  deliverText,
  ensureBrowser,
  listDsPages,
  pickWorkPage,
  readHistory,
  readPageUrl,
  readToken,
  sessionIdFromUrl,
  waitForDsOrigin,
  waitForNewMessage,
  type BrowserHandle,
} from './browser/page.ts'
import { CdpClient, fetchCdpVersion } from './browser/cdp.ts'

/** 引擎内部失败形态。 */
interface EngineFailure {
  ok: false
  code: DsTtsErrorCode
  error: string
  detail: string
  bizCode?: number
}

/** 一次"投递 + 合成"尝试的结果。 */
type AttemptOutcome =
  | { ok: true; sessionId: string; messageId: string; messageContent: string; audio: SynthAudio }
  | (EngineFailure & { stage: 'deliver' | 'session' | 'message' | 'synth' })

/** 队列登记（携带取消控制器）。 */
interface QueueEntry {
  id: string
  controller: AbortController
}

/** 引擎依赖。 */
export interface EngineDeps {
  /** 配置存储。 */
  config: ConfigStore
  /** 诊断日志（**不得**记录凭据）。 */
  log: (message: string, data?: unknown) => void
}

/** DS 官方朗读合成引擎。 */
export class TtsEngine {
  private readonly deps: EngineDeps
  private chain: Promise<unknown> = Promise.resolve()
  private pending: QueueEntry[] = []
  private activeEntry: QueueEntry | undefined
  private browser: BrowserHandle | undefined
  private lastBrowserError = ''
  private cacheHits = 0
  private cacheMisses = 0
  private pruned = false

  /**
   * @param deps - 配置存储与日志。
   */
  constructor(deps: EngineDeps) {
    this.deps = deps
  }

  /* ───────────────────────────── 队列 ───────────────────────────── */

  /** 排队中的任务数。 */
  get queueLength(): number {
    return this.pending.length
  }

  /** 是否有任务正在执行。 */
  get isBusy(): boolean {
    return this.activeEntry !== undefined
  }

  /**
   * 串行执行（前一个失败不影响后一个）。
   * @param entry - 队列登记。
   * @param work - 实际工作。
   * @returns 工作结果。
   */
  private enqueue<T>(entry: QueueEntry, work: () => Promise<T>): Promise<T> {
    this.pending.push(entry)
    const run = async (): Promise<T> => {
      const index = this.pending.indexOf(entry)
      if (index >= 0) this.pending.splice(index, 1)
      this.activeEntry = entry
      try {
        return await work()
      } finally {
        if (this.activeEntry === entry) this.activeEntry = undefined
      }
    }
    const result = this.chain.then(run, run)
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  /**
   * 取消排队中/进行中的合成。
   * @param id - 指定 id；缺省取消全部。
   * @returns 被取消的数量。
   */
  cancel(id?: string): CancelResult {
    const targets: QueueEntry[] = []
    if (id === undefined) {
      targets.push(...this.pending)
      if (this.activeEntry !== undefined) targets.push(this.activeEntry)
    } else {
      targets.push(...this.pending.filter((entry) => entry.id === id))
      if (this.activeEntry?.id === id) targets.push(this.activeEntry)
    }
    for (const entry of targets) entry.controller.abort()
    return { ok: true, cancelled: targets.length }
  }

  /* ─────────────────────────── 浏览器/凭据 ─────────────────────────── */

  /**
   * 确保浏览器可用（复用缓存句柄；附着式句柄每次重新确认）。
   * @param cfg - 生效配置。
   * @returns 句柄或失败。
   */
  private async ensureBrowserFor(cfg: DsTtsConfigView): Promise<BrowserHandle | EngineFailure> {
    if (this.browser !== undefined && this.browser.launched) {
      const live = await fetchCdpVersion(this.browser.base, 1500)
      if (live !== undefined) return this.browser
      this.browser = undefined
    }
    const handle = await ensureBrowser(cfg)
    if (!handle.ok) {
      this.browser = undefined
      this.lastBrowserError = handle.error
      return { ok: false, code: handle.code, error: handle.error, detail: handle.detail }
    }
    this.browser = handle
    this.lastBrowserError = ''
    return handle
  }

  /**
   * 打开一个可用的 DS 页面并连上它。
   * @param cfg - 生效配置。
   * @param effectiveSessionId - 专用会话 id（空串=需要一个新会话）。
   * @returns CDP 客户端或失败。
   */
  private async openPage(cfg: DsTtsConfigView, effectiveSessionId: string): Promise<{ ok: true; client: CdpClient } | EngineFailure> {
    const handle = await this.ensureBrowserFor(cfg)
    if (!handle.ok) return handle
    const page = await pickWorkPage(handle.base, effectiveSessionId)
    if (!page.ok) return { ok: false, code: page.code, error: page.error, detail: page.detail }
    let client: CdpClient
    try {
      client = await attach(page.target)
    } catch (error) {
      return {
        ok: false,
        code: 'NO_BROWSER',
        error: '连接 DS 页面失败',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
    // 关键：`/json/new` 返回时新标签页往往还在 about:blank，此时读 localStorage 会抛
    // SecurityError（被我们的 catch 当成"未登录"）。所以**先等页面真正落在 DS 源上**，
    // 再把 client 交出去 —— 这是"登录完还说没登录"的根因修复。
    const ready = await waitForDsOrigin(client, 20000)
    if (!ready.ok) {
      client.close()
      return {
        ok: false,
        code: 'PAGE_NOT_READY',
        error: 'DS 页面还没加载完成，请稍后重试',
        detail: ready.detail,
      }
    }
    return { ok: true, client }
  }

  /**
   * 从页面读 token（仅当次使用，不落盘、不日志）。
   * @param client - 页面连接。
   * @returns token 或"未登录"失败。
   */
  private async takeToken(client: CdpClient): Promise<{ ok: true; token: string } | EngineFailure> {
    let token = ''
    try {
      token = await readToken(client)
    } catch (error) {
      return {
        ok: false,
        code: 'NO_BROWSER',
        error: '读取页面登录态失败',
        detail: error instanceof Error ? error.message : String(error),
      }
    }
    if (token === '') {
      let pageUrl = ''
      try {
        pageUrl = await readPageUrl(client)
      } catch {
        // 读不到 URL 不影响结论
      }
      return {
        ok: false,
        code: 'NOT_LOGGED_IN',
        error: 'DS 页面里没有登录态',
        detail: `页面=${pageUrl === '' ? '(未知)' : pageUrl}；请在 ds-tts 拉起的浏览器窗口里登录一次 chat.deepseek.com（登录后不用重启，再点一次朗读即可）`,
      }
    }
    return { ok: true, token }
  }

  /* ─────────────────────────── 一次尝试 ─────────────────────────── */

  /**
   * 走完一次"投递 → 取 message_id → 合成"。
   * @param client - 页面连接。
   * @param token - 用户 token。
   * @param format - 本次请求的 DS 线上格式。
   * @param spec - 模式与投递文本。
   * @param signal - 取消信号。
   * @param deadline - 总截止时间戳。
   * @returns 成功产物或带阶段信息的失败。
   */
  private async runAttempt(
    client: CdpClient,
    token: string,
    format: DsTtsFormat,
    spec: { mode: DsTtsResolvedMode; deliveryText: string; waitRole: 'user' | 'assistant'; matchText: string; knownSessionId: string },
    signal: AbortSignal,
    deadline: number,
  ): Promise<AttemptOutcome> {
    // 1) 投递前基线：用来识别"新出现的"消息
    const baseline = new Set<string>()
    if (spec.knownSessionId !== '') {
      const before = await readHistory(client, spec.knownSessionId, 20000)
      if (before.ok) for (const message of before.messages) baseline.add(message.id)
    }

    // 2) 投递
    const delivered = await deliverText(client, spec.deliveryText)
    if (!delivered.ok) {
      return { ok: false, stage: 'deliver', code: delivered.code, error: delivered.error, detail: delivered.detail }
    }
    this.deps.log('已投递文本', { mode: spec.mode, method: delivered.method, selector: delivered.selector })

    // 3) 会话 id（新会话要投递后才知道）
    const url = await readPageUrl(client)
    const fromUrl = sessionIdFromUrl(url)
    const sessionId = fromUrl !== '' ? fromUrl : spec.knownSessionId
    if (sessionId === '') {
      return {
        ok: false,
        stage: 'session',
        code: 'DELIVER_FAILED',
        error: '投递完成后仍拿不到 DS 会话 id',
        detail: `页面 URL=${url === '' ? '(空)' : url}`,
      }
    }

    // 4) 等新消息
    const found = await waitForNewMessage(client, sessionId, {
      baselineIds: baseline,
      role: spec.waitRole,
      matchText: spec.matchText,
      timeoutMs: Math.min(Math.max(5000, deadline - Date.now()), 90000),
      signal,
    })
    if (!found.ok) {
      return { ok: false, stage: 'message', code: found.code, error: found.error, detail: found.detail }
    }
    if (found.degraded) {
      this.deps.log('未等到完成态就取音频（消息可能仍在生成）', { messageId: found.message.id, status: found.message.status })
    }

    // 5) 合成
    const audio = await synthFromMessage({
      token,
      chatSessionId: sessionId,
      messageId: found.message.id,
      format,
      signal,
      timeoutMs: Math.max(5000, deadline - Date.now()),
    })
    if (!audio.ok) {
      const failure: AttemptOutcome = {
        ok: false,
        stage: 'synth',
        code: audio.code,
        error: audio.error,
        detail: audio.detail,
      }
      if (audio.bizCode !== undefined) failure.bizCode = audio.bizCode
      return failure
    }
    return { ok: true, sessionId, messageId: found.message.id, messageContent: found.message.content, audio: audio.data }
  }

  /* ─────────────────────────── 音频落地 ─────────────────────────── */

  /**
   * 把服务端音频变成可播放文件字节。
   * @param audio - 服务端产物。
   * @returns 文件字节、扩展名、时长（秒）与说明。
   */
  private async materialize(audio: SynthAudio): Promise<{ bytes: Uint8Array; ext: 'wav' | 'mp3' | 'opus'; seconds: number; note: string }> {
    const serverFormat = audio.serverFormat === '' ? 'pcm' : audio.serverFormat
    if (serverFormat !== 'opus') {
      const wav = pcmToWav(audio.bytes)
      return { bytes: wav, ext: 'wav', seconds: pcmDurationSeconds(audio.bytes.length), note: '' }
    }
    // Opus：带 Ogg 容器且有 ffmpeg 才转 MP3；裸包原样落盘（宁可不转，也不产坏文件）
    if (isOggContainer(audio.bytes)) {
      const ffmpeg = await findFfmpeg('')
      if (ffmpeg !== undefined) {
        const tmpDir = join(cacheDirPath(), '.tmp')
        const stamp = Date.now().toString()
        const oggPath = join(tmpDir, `ds-tts-${stamp}.ogg`)
        const mp3Path = join(tmpDir, `ds-tts-${stamp}.mp3`)
        try {
          await mkdir(tmpDir, { recursive: true })
          await writeFile(oggPath, audio.bytes)
          const converted = await encodeOggToMp3(ffmpeg, oggPath, mp3Path)
          if (converted.ok) {
            const mp3 = await readFile(mp3Path)
            return { bytes: new Uint8Array(mp3), ext: 'mp3', seconds: 0, note: '' }
          }
          this.deps.log('Opus→MP3 转码失败，原样落 .opus', converted.detail)
        } catch (error) {
          this.deps.log('Opus→MP3 转码异常，原样落 .opus', error instanceof Error ? error.message : String(error))
        } finally {
          await unlink(oggPath).catch(() => undefined)
          await unlink(mp3Path).catch(() => undefined)
        }
      }
    }
    return { bytes: audio.bytes, ext: 'opus', seconds: 0, note: '服务端返回的是裸 Opus 包，已原样保存为 .opus' }
  }

  /* ──────────────────────────── 主流程 ──────────────────────────── */

  /**
   * 文本进、音频出。
   * @param request - 合成请求。
   * @param external - 外部取消信号（工具传 `exec.signal`，实现协作式取消）。
   * @returns 成功带 URL 与元数据；失败带结构化错误码。
   */
  async synthesize(request: SynthesizeRequest, external?: AbortSignal): Promise<SynthesizeResult> {
    const started = Date.now()
    const cfg = await this.deps.config.view()
    const runtime = await this.deps.config.runtime()

    const normalized = normalizeForSpeech(request.text ?? '', cfg.maxChars)
    if (normalized.text.trim() === '') {
      return {
        ok: false,
        code: 'NO_CONTENT',
        error: '这段内容没有可朗读的正文（可能整段都是代码块、表格或链接）',
        detail: `原文字符数 ${normalized.originalChars.toString()}，其中代码块 ${normalized.stats.codeBlocks.toString()} 段`,
      }
    }
    // 超长语义：正常情况按 maxChars 在句末截断，并把 truncated 透传给 UI 提示；
    // 只有离谱的超长（8 倍以上）才直接拒绝，避免把几百 KB 文本灌进 DS 页面。
    if (normalized.originalChars > cfg.maxChars * 8) {
      return {
        ok: false,
        code: 'TOO_LONG',
        error: `文本太长（${normalized.originalChars.toString()} 字，上限约 ${cfg.maxChars.toString()} 字）`,
        detail: '请分段朗读，或在设置里调大 maxChars',
      }
    }
    const text = normalized.text
    const voice = request.voice !== undefined && request.voice !== '' ? request.voice : cfg.voice
    const format: DsTtsFormat = request.format ?? cfg.format
    const requestedMode = request.mode ?? cfg.mode
    const regenerate = request.regenerate === true
    const id = cacheId([voice, format, text])
    const dir = cacheDirPath()

    void this.maybePrune(cfg, dir)

    // 缓存命中：完全不碰浏览器。
    // `regenerate` 时刻意跳过这一步 —— 用户就是要再合成一版（DS 每次的声音可能不同）。
    if (shouldReadCache(cfg.cacheEnabled, regenerate)) {
      const hit = await readCache(dir, id)
      if (hit !== undefined) {
        this.cacheHits += 1
        const mode: DsTtsResolvedMode = hit.meta?.mode === 'echo' ? 'echo' : 'user'
        const version = audioVersion(hit.meta?.audioId, hit.meta?.at ?? Date.now())
        return {
          ok: true,
          id,
          url: audioUrlWithVersion(id, hit.ext, version),
          version,
          regenerated: false,
          ext: hit.ext,
          bytes: hit.bytes,
          ms: Date.now() - started,
          cached: true,
          voice: hit.meta?.voice ?? voice,
          mode,
          seconds: hit.meta?.seconds ?? 0,
          text,
          truncated: hit.meta?.truncated ?? normalized.truncated,
        }
      }
    }
    this.cacheMisses += 1

    const entry: QueueEntry = { id, controller: new AbortController() }
    const signal = entry.controller.signal
    const deadline = Date.now() + cfg.timeoutMs
    // 外部取消（工具 exec.signal / 路由断开）直接落到本次任务的内部控制上
    const onExternalAbort = (): void => {
      entry.controller.abort()
    }
    if (external?.aborted === true) entry.controller.abort()
    else external?.addEventListener('abort', onExternalAbort, { once: true })

    try {
      return await this.enqueue(entry, async () => {
      if (signal.aborted) {
        return { ok: false, code: 'CANCELLED', error: '已取消', detail: '' } satisfies SynthesizeResult
      }
      const live = await this.deps.config.runtime()
      const effectiveSessionId = live.chatSessionId !== '' ? live.chatSessionId : cfg.chatSessionId
      const opened = await this.openPage(cfg, effectiveSessionId)
      if (!opened.ok) return this.toError(opened)
      const client = opened.client
      try {
        const tokenResult = await this.takeToken(client)
        if (!tokenResult.ok) return this.toError(tokenResult)
        const token = tokenResult.token

        const attempt = async (mode: DsTtsResolvedMode): Promise<AttemptOutcome> =>
          await this.runAttempt(
            client,
            token,
            format,
            {
              mode,
              deliveryText: mode === 'user' ? text : cfg.echoPrompt.replace('{text}', text),
              waitRole: mode === 'user' ? 'user' : 'assistant',
              matchText: mode === 'user' ? text : '',
              knownSessionId: effectiveSessionId,
            },
            signal,
            deadline,
          )

        const order = resolveAttemptOrder(requestedMode, live.userModeSupported)
        let mode: DsTtsResolvedMode = order[0] ?? 'echo'
        let outcome = await attempt(mode)

        if (!outcome.ok && order.length > 1 && this.isRetryableAsEcho(outcome)) {
          this.deps.log('user 模式不可用，降级 echo 模式', { code: outcome.code, bizCode: outcome.bizCode })
          await this.deps.config.setRuntime({ userModeSupported: false })
          mode = order[1] ?? 'echo'
          outcome = await attempt(mode)
        }

        if (!outcome.ok) return this.toError(outcome)

        // 记住可用模式与专用会话
        if (mode === 'user' && live.userModeSupported !== true) {
          await this.deps.config.setRuntime({ userModeSupported: true })
        }
        if (outcome.sessionId !== live.chatSessionId) {
          await this.deps.config.setRuntime({ chatSessionId: outcome.sessionId })
        }

        // 内容校验：能拿到正文时，确认要朗读的确实是预期文本（否则可能读错消息）；
        // 但历史接口这次没给正文时**不判死** —— 合成只需要 message_id，
        // 服务端自己会取正文，所以"没有正文"只是"无法校验"，不是"不能朗读"。
        if (outcome.messageContent.trim() === '') {
          this.deps.log('历史未返回正文，跳过内容校验', { mode, messageId: outcome.messageId })
        } else if (cfg.echoVerify && !this.looksLikeExpected(text, outcome.messageContent)) {
          return {
            ok: false,
            code: 'SYNTH_FAILED',
            error:
              mode === 'echo'
                ? '模型没有原样复述（长文本更容易走样）。请在设置里调小 maxChars 后分段朗读，或关闭内容校验'
                : '取到的消息正文与原文不一致，已放弃（可在设置里关闭校验）',
            detail: `原文 ${text.length.toString()} 字 / 取到 ${outcome.messageContent.length.toString()} 字：${outcome.messageContent.slice(0, 120)}`,
          } satisfies SynthesizeResult
        }

        const materialized = await this.materialize(outcome.audio)
        if (cfg.cacheEnabled) {
          const meta: Omit<CacheMeta, 'id' | 'bytes' | 'at' | 'ext'> = {
            voice: outcome.audio.voiceId !== '' ? outcome.audio.voiceId : voice,
            mode,
            format,
            seconds: materialized.seconds,
            audioId: outcome.audio.audioId,
            traceId: outcome.audio.traceId,
            serverFormat: outcome.audio.serverFormat,
            text,
            truncated: normalized.truncated,
          }
          try {
            await writeCache(dir, id, materialized.ext, materialized.bytes, meta)
          } catch (error) {
            this.deps.log('写缓存失败', error instanceof Error ? error.message : String(error))
          }
        }
        const seconds = materialized.ext === 'wav' ? wavDurationSeconds(materialized.bytes) : materialized.seconds
        // 版本令牌取 DS 侧 audio_id：每次合成唯一，于是重新生成必然产生新 URL，
        // 浏览器不会拿 immutable 的旧缓存糊弄我们。
        const version = audioVersion(outcome.audio.audioId, Date.now())
        this.deps.log('合成完成', { id, ext: materialized.ext, bytes: materialized.bytes.length, mode, version, regenerate, note: materialized.note })
        return {
          ok: true,
          id,
          url: audioUrlWithVersion(id, materialized.ext, version),
          version,
          regenerated: regenerate,
          ext: materialized.ext,
          bytes: materialized.bytes.length,
          ms: Date.now() - started,
          cached: false,
          voice: outcome.audio.voiceId !== '' ? outcome.audio.voiceId : voice,
          mode,
          seconds,
          text,
          truncated: normalized.truncated,
        } satisfies SynthesizeResult
      } finally {
        client.close()
      }
      })
    } finally {
      external?.removeEventListener('abort', onExternalAbort)
    }
  }

  /** 内部失败 → 对外错误分支。 */
  private toError(failure: EngineFailure): SynthesizeError {
    return {
      ok: false,
      code: failure.code,
      error: failure.error,
      ...(failure.detail === '' ? {} : { detail: failure.detail }),
    }
  }

  /** user 模式失败是否值得改用 echo 重试。 */
  private isRetryableAsEcho(outcome: AttemptOutcome): boolean {
    if (outcome.ok) return false
    if (outcome.stage === 'message') return true
    if (outcome.stage === 'synth' && outcome.bizCode !== undefined) return RETRY_AS_ECHO_CODES.includes(outcome.bizCode)
    return false
  }

  /** 取到的正文是否足够像预期文本（首尾双向包含，容忍 DS 侧的轻微规整）。 */
  private looksLikeExpected(expected: string, got: string): boolean {
    const a = expected.replace(/\s+/g, '')
    const b = got.replace(/\s+/g, '')
    if (a === '' || b === '') return false
    const head = a.slice(0, Math.min(60, a.length))
    const tail = a.slice(Math.max(0, a.length - 40))
    return b.includes(head) && b.includes(tail)
  }

  /** 首次调用时按保留期清理一次缓存。 */
  private async maybePrune(cfg: DsTtsConfigView, dir: string): Promise<void> {
    if (this.pruned) return
    this.pruned = true
    try {
      const removed = await pruneCache(dir, cfg.cacheKeepDays)
      if (removed > 0) this.deps.log('已清理过期缓存', removed)
    } catch {
      // 清理失败不影响主流程
    }
  }

  /* ─────────────────────────── 其它接口 ─────────────────────────── */

  /**
   * 取 DS 官方音色列表（默认 1 小时内存缓存）。
   * @param force - 跳过缓存强制刷新。
   * @returns 音色列表或结构化失败。
   */
  async voices(force = false): Promise<VoicesResult> {
    const cfg = await this.deps.config.view()
    const runtime = await this.deps.config.runtime()
    const cached = runtime.voicesCache
    if (!force && cached !== null && Date.now() - cached.at < 3600_000 && Array.isArray(cached.voices) && cached.voices.length > 0) {
      return {
        ok: true,
        voices: cached.voices as DsTtsVoice[],
        currentVoiceId: cached.currentVoiceId === '' ? null : cached.currentVoiceId,
        cached: true,
      }
    }
    const opened = await this.openPage(cfg, runtime.chatSessionId !== '' ? runtime.chatSessionId : cfg.chatSessionId)
    if (!opened.ok) return this.toError(opened)
    try {
      const token = await this.takeToken(opened.client)
      if (!token.ok) return this.toError(token)
      const res = await fetchVoices(token.token, { timeoutMs: 20000 })
      if (!res.ok) return { ok: false, code: res.code, error: res.error, detail: res.detail }
      await this.deps.config.setRuntime({
        voicesCache: { at: Date.now(), currentVoiceId: res.data.currentVoiceId ?? '', voices: res.data.voices },
      })
      return { ok: true, voices: res.data.voices, currentVoiceId: res.data.currentVoiceId, cached: false }
    } finally {
      opened.client.close()
    }
  }

  /**
   * 切换 DS 账号级朗读音色。
   * @param voiceId - 目标 voice_id。
   * @returns 成功或结构化失败。
   */
  async setVoice(voiceId: string): Promise<SetVoiceResult> {
    const cfg = await this.deps.config.view()
    const runtime = await this.deps.config.runtime()
    const opened = await this.openPage(cfg, runtime.chatSessionId !== '' ? runtime.chatSessionId : cfg.chatSessionId)
    if (!opened.ok) return this.toError(opened)
    try {
      const token = await this.takeToken(opened.client)
      if (!token.ok) return this.toError(token)
      const res = await dsSetVoice(token.token, voiceId, { timeoutMs: 20000 })
      if (!res.ok) return { ok: false, code: res.code, error: res.error, detail: res.detail }
      await this.deps.config.setRuntime({ voicesCache: null })
      return { ok: true, voiceId, note: '已改写你在 DS 账号里的「朗读音色」设置（官方接口是账号级的）' }
    } finally {
      opened.client.close()
    }
  }

  /**
   * 诊断快照。**不会**触发浏览器自启，也不会打开/导航任何标签页。
   * @returns 状态结果。
   */
  async status(): Promise<StatusResult> {
    const cfg = await this.deps.config.view()
    const runtime = await this.deps.config.runtime()

    const cdpUrl = cfg.cdpUrl !== '' ? cfg.cdpUrl : `http://127.0.0.1:${cfg.cdpPort.toString()}`
    let connected = false
    let browserVersion = ''
    if (this.browser !== undefined) {
      const live = await fetchCdpVersion(this.browser.base, 1200)
      if (live !== undefined) {
        connected = true
        browserVersion = live.browser
      } else {
        this.browser = undefined
      }
    }
    if (!connected) {
      const version = await fetchCdpVersion(cdpUrl, 1200)
      if (version !== undefined) {
        connected = true
        browserVersion = version.browser
      }
    }

    let loggedIn = false
    let pageUrl = ''
    let pageFound = false
    if (connected) {
      try {
        const pages = await listDsPages(cdpUrl)
        pageFound = pages.length > 0
        const target = pages[pages.length - 1]
        if (target !== undefined) {
          const client = await attach(target)
          try {
            // 只有页面真的落在 DS 源上才读 token，否则会重现"未登录"的误判
            const ready = await waitForDsOrigin(client, 3000)
            pageUrl = ready.ok ? ready.href : await readPageUrl(client)
            if (ready.ok) loggedIn = (await readToken(client)) !== ''
          } finally {
            client.close()
          }
        }
      } catch {
        // 状态查询不应抛
      }
    }

    const stats = await cacheStats(cacheDirPath())
    return {
      ok: true,
      browser: {
        connected,
        cdpUrl: connected ? cdpUrl : '',
        browserVersion,
        pageUrl,
        launched: this.browser?.launched ?? false,
        lastError: this.lastBrowserError,
      },
      ds: {
        pageFound,
        loggedIn,
        allowed: runtime.lastProbe === null ? null : runtime.lastProbe.code === 0,
        lastProbe: runtime.lastProbe,
        userModeSupported: runtime.userModeSupported,
        chatSessionId: runtime.chatSessionId !== '' ? runtime.chatSessionId : cfg.chatSessionId,
      },
      queue: { pending: this.pending.length, active: this.activeEntry !== undefined },
      cache: { files: stats.files, bytes: stats.bytes, hits: this.cacheHits, misses: this.cacheMisses },
      config: cfg,
    }
  }

  /**
   * 显式探针：读 token + 列音色，把服务端放行结论写进运行时状态（供状态页展示）。
   * @returns 探测到的结果；失败时 code 为 -1。
   */
  async probeAccess(): Promise<{ code: number; msg: string }> {
    const cfg = await this.deps.config.view()
    const runtime = await this.deps.config.runtime()
    const opened = await this.openPage(cfg, runtime.chatSessionId !== '' ? runtime.chatSessionId : cfg.chatSessionId)
    const record = async (result: { code: number; msg: string }): Promise<{ code: number; msg: string }> => {
      await this.deps.config.setRuntime({ lastProbe: { ...result, at: Date.now() } })
      return result
    }
    if (!opened.ok) return await record({ code: -1, msg: opened.error })
    try {
      const token = await this.takeToken(opened.client)
      if (!token.ok) return await record({ code: -1, msg: token.error })
      const res = await fetchVoices(token.token, { timeoutMs: 15000 })
      if (res.ok) {
        await this.deps.config.setRuntime({
          voicesCache: { at: Date.now(), currentVoiceId: res.data.currentVoiceId ?? '', voices: res.data.voices },
        })
        return await record({ code: 0, msg: `可用，检测到 ${res.data.voices.length.toString()} 个音色` })
      }
      return await record({ code: -1, msg: `${res.error}${res.detail === '' ? '' : `（${res.detail}）`}` })
    } finally {
      opened.client.close()
    }
  }
}
