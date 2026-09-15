/**
 * 测试公共设施：把 DSH_HOME 指到一个临时目录（**绝不碰真实的 ~/.dsh**），
 * 然后再动态 import 构建产物 lib/testing.js —— 这样 paths.ts 里的
 * resolveDshHome() 读到的就是我们给的临时 home。
 */
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 本次测试进程独占的临时 DSH home。 */
export const dshHome = await mkdtemp(join(tmpdir(), 'ds-tts-test-'))
process.env.DSH_HOME = dshHome

/** 构建产物里的内部零件。 */
export const T = await import('../lib/testing.js')

/** 造一个假 IncomingMessage。 */
export function makeReq(options = {}) {
  const { method = 'GET', url = '/', body, remoteAddress = '127.0.0.1', host = '127.0.0.1:3080', headers = {} } = options
  const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    socket: { remoteAddress },
    headers: { host, ...headers },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 造一个假 ServerResponse。 */
export function makeRes() {
  const state = { status: 0, headers: {}, body: undefined }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers ?? {}
    },
    end(payload) {
      state.body = payload
    },
  }
}

/** 从假响应里取 JSON。 */
export function jsonOf(res) {
  return JSON.parse(String(res.state.body))
}

/**
 * 从路由数组里按 path 找一条。
 * @param {readonly {path: string}[]} routes - 路由数组。
 * @param {string} path - 目标路径。
 */
export function routeOf(routes, path) {
  const found = routes.find((route) => route.path === path)
  if (found === undefined) throw new Error(`route not found: ${path}`)
  return found
}

/** 一个只回错误/成功的最小 stub 引擎。 */
export function stubEngine(overrides = {}) {
  return {
    async synthesize() {
      return { ok: false, code: 'SYNTH_FAILED', error: 'stub' }
    },
    async voices() {
      return { ok: true, voices: [], currentVoiceId: null, cached: false }
    },
    async setVoice(voiceId) {
      return { ok: true, voiceId, note: 'stub' }
    },
    async status() {
      return {
        ok: true,
        browser: { connected: false, cdpUrl: '', browserVersion: '', pageUrl: '', launched: false, lastError: '' },
        ds: { loggedIn: false, allowed: null, lastProbe: null, userModeSupported: null, chatSessionId: '' },
        queue: { pending: 0, active: false },
        cache: { files: 0, bytes: 0, hits: 0, misses: 0 },
        config: {},
      }
    },
    cancel() {
      return { ok: true, cancelled: 0 }
    },
    async probeAccess() {
      return { code: -1, msg: 'stub' }
    },
    ...overrides,
  }
}
