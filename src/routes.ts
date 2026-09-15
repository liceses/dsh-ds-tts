/**
 * 宿主 HTTP 路由层（纯 HTTP 关注点：护栏、解析、状态码）。
 *
 * 所有写入型/取音频型路由都带**仅回环 + 同源**护栏（照搬 dsh-text-drop 的成熟做法）：
 * 本插件会驱动本机浏览器、并能把音频写进工作区，绝不能对 LAN 暴露。
 *
 * 业务编排全在 engine.ts；这里只负责把 HTTP 翻译成引擎调用，再翻译回来。
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import {
  AUDIO_EXTS,
  AUDIO_ID_PATTERN,
  type AudioExt,
  type CancelResult,
  type DsTtsConfigPatch,
  type DsTtsConfigView,
  type ExportRequest,
  type ExportResult,
  type SetVoiceRequest,
  type SetVoiceResult,
  type StatusResult,
  type SynthesizeRequest,
  type SynthesizeResult,
  type VoicesResult,
} from './protocol.ts'
import {
  AUDIO_PATH,
  CANCEL_PATH,
  CONFIG_PATH,
  EXPORT_PATH,
  STATUS_PATH,
  SYNTHESIZE_PATH,
  VOICES_PATH,
  VOICE_PATH,
} from './routes-shared.ts'
import { contentTypeOf } from './audio/wav.ts'

/** JSON body 上限（文本与配置都远小于此）。 */
export const MAX_BODY_BYTES = 1024 * 1024

/** 导出文件名的去重尝试上限。 */
const MAX_NAME_ATTEMPTS = 1000

/** 会话存储的最小结构面。 */
export interface SessionFace {
  get(id: string): { meta?: { cwd?: string } } | undefined
}

/** 持久化会话读取器的最小结构面。 */
export interface SessionQueryFace {
  readSession(id: string): Promise<{ meta?: { cwd?: string } }>
}

/** 引擎面（便于单测注入 stub）。 */
export interface EngineFaces {
  synthesize(request: SynthesizeRequest): Promise<SynthesizeResult>
  voices(force?: boolean): Promise<VoicesResult>
  setVoice(voiceId: string): Promise<SetVoiceResult>
  status(): Promise<StatusResult>
  cancel(id?: string): CancelResult
  probeAccess(): Promise<{ code: number; msg: string }>
}

/** 配置面。 */
export interface ConfigFaces {
  view(): Promise<DsTtsConfigView>
  patch(patch: DsTtsConfigPatch): Promise<DsTtsConfigView>
}

/** 路由依赖。 */
export interface RoutesDeps {
  engine: EngineFaces
  config: ConfigFaces
  /** 音频缓存目录。 */
  cacheDir: string
  sessions?: SessionFace | undefined
  sessionQuery?: SessionQueryFace | undefined
  sandboxPolicy?: { workspaceRoot?: string } | undefined
  log?: ((message: string, data?: unknown) => void) | undefined
}

/** 仅回环 + 同源标记检查。 */
function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = request.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (request.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = request.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** 写一个 JSON 响应。 */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** 读 JSON body（超限或不可解析返回 undefined）。 */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/** 取 URL pathname（忽略查询串）。 */
function pathnameOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://localhost').pathname
  } catch {
    return req.url ?? '/'
  }
}

/** 净化导出文件名（去路径分隔符、非法字符，并彻底杜绝 `..` 序列）。 */
function sanitizeName(name: string): string {
  const base = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    // 纵深防御：即使分隔符已被替换，也不允许文件名里出现任何 `..` 序列
    .replace(/\.{2,}/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return base === '' ? 'tts.wav' : base
}

/** HTTP 状态码 ↔ 错误码。 */
function statusOf(code: string): number {
  switch (code) {
    case 'FORBIDDEN':
      return 403
    case 'BAD_REQUEST':
      return 400
    case 'TOO_LONG':
      return 413
    default:
      return 500
  }
}

/** 配置补丁白名单与类型校验。 */
function sanitizePatch(raw: unknown): { ok: true; patch: DsTtsConfigPatch } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'config patch 必须是对象' }
  const row = raw as Record<string, unknown>
  const patch: Record<string, unknown> = {}
  const strings = ['voice', 'format', 'mode', 'cdpUrl', 'browserPath', 'userDataDir', 'chatSessionId', 'echoPrompt', 'ffplayPath'] as const
  const numbers = ['maxChars', 'cdpPort', 'timeoutMs', 'cacheKeepDays'] as const
  const booleans = ['autoLaunch', 'echoVerify', 'cacheEnabled'] as const
  for (const key of Object.keys(row)) {
    const disallowed = !(strings as readonly string[]).includes(key) && !(numbers as readonly string[]).includes(key) && !(booleans as readonly string[]).includes(key)
    if (disallowed) return { ok: false, error: `不认识的配置项：${key}` }
  }
  for (const key of strings) {
    const value = row[key]
    if (value === undefined) continue
    if (typeof value !== 'string') return { ok: false, error: `${key} 必须是字符串` }
    patch[key] = value
  }
  for (const key of numbers) {
    const value = row[key]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: `${key} 必须是数字` }
    patch[key] = value
  }
  for (const key of booleans) {
    const value = row[key]
    if (value === undefined) continue
    if (typeof value !== 'boolean') return { ok: false, error: `${key} 必须是布尔` }
    patch[key] = value
  }
  return { ok: true, patch: patch as DsTtsConfigPatch }
}

/** 解析 DS 会话工作区根：live session → 持久化 session → sandboxPolicy。 */
async function resolveWorkspaceRoot(deps: RoutesDeps, sessionId: string): Promise<string | undefined> {
  const live = deps.sessions?.get(sessionId)?.meta?.cwd
  if (live !== undefined && live !== '') return live
  if (deps.sessionQuery !== undefined) {
    try {
      const persisted = (await deps.sessionQuery.readSession(sessionId)).meta?.cwd
      if (persisted !== undefined && persisted !== '') return persisted
    } catch {
      // 会话可能还没落盘
    }
  }
  const fallback = deps.sandboxPolicy?.workspaceRoot
  return fallback !== undefined && fallback !== '' ? fallback : undefined
}

/**
 * 构造全部 ds-tts 路由。
 * @param deps - 引擎/配置/工作区解析依赖。
 * @returns 路由数组（交给 `ctx.webServer.register`）。
 */
export function makeRoutes(deps: RoutesDeps): WebRoute[] {
  const log = deps.log ?? ((): void => undefined)

  /** 统一护栏前置。 */
  const guard = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (!isLoopbackRequest(req)) {
      writeJson(res, 403, { ok: false, code: 'FORBIDDEN', error: 'forbidden: loopback-only' })
      return false
    }
    return true
  }

  const synthesize: WebRoute = {
    kind: 'exact',
    path: SYNTHESIZE_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method ?? 'GET') !== 'POST') {
        writeJson(res, 405, { ok: false, code: 'BAD_REQUEST', error: `method not allowed: ${req.method ?? ''}` })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        writeJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'invalid JSON body or body too large' })
        return
      }
      const row = body as Record<string, unknown>
      const text = typeof row.text === 'string' ? row.text : ''
      if (text.trim() === '') {
        writeJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'text is required' })
        return
      }
      const request: SynthesizeRequest = { text }
      if (typeof row.sessionId === 'string') request.sessionId = row.sessionId
      if (typeof row.voice === 'string' && row.voice !== '') request.voice = row.voice
      if (row.format === 'pcm' || row.format === 'opus') request.format = row.format
      if (row.mode === 'auto' || row.mode === 'user' || row.mode === 'echo') request.mode = row.mode
      if (row.regenerate === true) request.regenerate = true
      const result = await deps.engine.synthesize(request)
      writeJson(res, result.ok ? 200 : statusOf(result.code), result)
    },
  }

  const audio: WebRoute = {
    kind: 'prefix',
    path: AUDIO_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method ?? 'GET') !== 'GET') {
        writeJson(res, 405, { ok: false, code: 'BAD_REQUEST', error: 'method not allowed' })
        return
      }
      const pathname = pathnameOf(req)
      const tail = pathname.slice(AUDIO_PATH.length + 1)
      const dot = tail.lastIndexOf('.')
      const id = dot > 0 ? tail.slice(0, dot) : ''
      const ext = dot > 0 ? tail.slice(dot + 1) : ''
      if (!AUDIO_ID_PATTERN.test(id) || !(AUDIO_EXTS as readonly string[]).includes(ext)) {
        writeJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'invalid audio id or extension' })
        return
      }
      const file = join(deps.cacheDir, `${id}.${ext}`)
      try {
        const info = await stat(file)
        if (!info.isFile()) throw new Error('not a file')
        const bytes = await readFile(file)
        res.writeHead(200, {
          'content-type': contentTypeOf(ext),
          'content-length': bytes.length.toString(),
          'cache-control': 'public, max-age=31536000, immutable',
          'content-disposition': `inline; filename="ds-tts-${id}.${ext}"`,
          'x-content-type-options': 'nosniff',
        })
        res.end(bytes)
      } catch {
        writeJson(res, 404, { ok: false, code: 'BAD_REQUEST', error: 'audio not found (cache may have been pruned)' })
      }
    },
  }

  const exportRoute: WebRoute = {
    kind: 'exact',
    path: EXPORT_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method ?? 'GET') !== 'POST') {
        writeJson(res, 405, { ok: false, code: 'BAD_REQUEST', error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        writeJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'invalid JSON body' })
        return
      }
      const row = body as unknown as ExportRequest
      const id = typeof row.id === 'string' ? row.id : ''
      const ext = typeof row.ext === 'string' ? row.ext : ''
      const sessionId = typeof row.sessionId === 'string' ? row.sessionId : ''
      if (!AUDIO_ID_PATTERN.test(id) || !(AUDIO_EXTS as readonly string[]).includes(ext) || sessionId === '') {
        writeJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'id, ext and sessionId are required' })
        return
      }
      const source = join(deps.cacheDir, `${id}.${ext}`)
      let bytes: Buffer
      try {
        bytes = await readFile(source)
      } catch {
        writeJson(res, 404, { ok: false, code: 'BAD_REQUEST', error: '音频不在缓存里（可能已被清理），请重新朗读一次' })
        return
      }
      const root = await resolveWorkspaceRoot(deps, sessionId)
      if (root === undefined) {
        writeJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'cannot resolve a workspace root for this session' })
        return
      }
      try {
        const dir = join(root, '.dsh', 'tts')
        await mkdir(dir, { recursive: true })
        const requested = typeof row.fileName === 'string' && row.fileName !== '' ? row.fileName : `ds-tts-${id}.${ext}`
        const base = sanitizeName(requested.endsWith(`.${ext}`) ? requested : `${requested}.${ext}`)
        const dot = base.lastIndexOf('.')
        const stem = dot > 0 ? base.slice(0, dot) : base
        const extension = dot > 0 ? base.slice(dot) : ''
        let candidate = base
        let target = join(dir, candidate)
        let attempts = 0
        while ((await stat(target).catch(() => undefined)) !== undefined) {
          attempts += 1
          if (attempts >= MAX_NAME_ATTEMPTS) {
            writeJson(res, 500, { ok: false, code: 'INTERNAL', error: 'cannot allocate a unique file name' })
            return
          }
          candidate = `${stem}-${attempts.toString()}${extension}`
          target = join(dir, candidate)
        }
        await writeFile(target, bytes)
        log('已导出音频', { path: target, bytes: bytes.length })
        writeJson(res, 200, { ok: true, path: target, name: candidate } satisfies ExportResult)
      } catch (error) {
        writeJson(res, 500, {
          ok: false,
          code: 'INTERNAL',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }

  const voices: WebRoute = {
    kind: 'exact',
    path: VOICES_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const force = (req.url ?? '').includes('force=1')
      const result = await deps.engine.voices(force)
      writeJson(res, result.ok ? 200 : statusOf(result.code), result)
    },
  }

  const setVoice: WebRoute = {
    kind: 'exact',
    path: VOICE_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method ?? 'GET') !== 'POST') {
        writeJson(res, 405, { ok: false, code: 'BAD_REQUEST', error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      if (body === undefined) {
        writeJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'invalid JSON body' })
        return
      }
      const row = body as unknown as SetVoiceRequest
      const voiceId = typeof row.voiceId === 'string' ? row.voiceId : ''
      if (voiceId === '') {
        writeJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'voiceId is required' })
        return
      }
      const result = await deps.engine.setVoice(voiceId)
      writeJson(res, result.ok ? 200 : statusOf(result.code), result)
    },
  }

  const status: WebRoute = {
    kind: 'exact',
    path: STATUS_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.url ?? '').includes('probe=1')) {
        await deps.engine.probeAccess()
      }
      const result = await deps.engine.status()
      writeJson(res, 200, result)
    },
  }

  const config: WebRoute = {
    kind: 'exact',
    path: CONFIG_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      const method = req.method ?? 'GET'
      if (method === 'GET') {
        writeJson(res, 200, { ok: true, config: await deps.config.view() })
        return
      }
      if (method === 'PUT' || method === 'POST') {
        const body = await readJsonBody(req)
        if (body === undefined) {
          writeJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: 'invalid JSON body' })
          return
        }
        const sanitized = sanitizePatch(body)
        if (!sanitized.ok) {
          writeJson(res, 400, { ok: false, code: 'BAD_REQUEST', error: sanitized.error })
          return
        }
        const next = await deps.config.patch(sanitized.patch)
        log('配置已更新', Object.keys(sanitized.patch))
        writeJson(res, 200, { ok: true, config: next })
        return
      }
      writeJson(res, 405, { ok: false, code: 'BAD_REQUEST', error: `method not allowed: ${method}` })
    },
  }

  const cancel: WebRoute = {
    kind: 'exact',
    path: CANCEL_PATH,
    handler: async (req, res) => {
      if (!guard(req, res)) return
      if ((req.method ?? 'GET') !== 'POST') {
        writeJson(res, 405, { ok: false, code: 'BAD_REQUEST', error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      const row = (body ?? {}) as Record<string, unknown>
      const id = typeof row.id === 'string' && row.id !== '' ? row.id : undefined
      const result: CancelResult = deps.engine.cancel(id)
      writeJson(res, 200, result)
    },
  }

  return [synthesize, audio, exportRoute, voices, setVoice, status, config, cancel]
}

/** 供类型断言使用：音频扩展名白名单。 */
export const ALLOWED_AUDIO_EXTS: readonly AudioExt[] = AUDIO_EXTS
