/**
 * HTTP 路由层：护栏、状态码、以及"导出真的落盘"。
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { T, jsonOf, makeReq, makeRes, routeOf, stubEngine } from './helpers.mjs'

const CACHE_DIR = await mkdtemp(join(tmpdir(), 'ds-tts-routes-cache-'))
const WORKSPACE = await mkdtemp(join(tmpdir(), 'ds-tts-routes-ws-'))

const DEFAULT_CONFIG = {
  voice: 'mira',
  format: 'pcm',
  mode: 'auto',
  maxChars: 2000,
  cdpUrl: '',
  cdpPort: 9222,
  browserPath: '',
  userDataDir: '',
  autoLaunch: true,
  chatSessionId: '',
  echoPrompt: '原样输出：{text}',
  echoVerify: true,
  timeoutMs: 120000,
  cacheEnabled: true,
  cacheKeepDays: 30,
  ffplayPath: '',
}

/** 用真实 ConfigStore（写到临时 DSH_HOME）构造路由。 */
function buildRoutes(engineOverrides = {}) {
  const store = new T.ConfigStore(T.Config({}))
  return T.makeRoutes({
    engine: stubEngine(engineOverrides),
    config: { view: () => store.view(), patch: (patch) => store.patch(patch) },
    cacheDir: CACHE_DIR,
    sandboxPolicy: { workspaceRoot: WORKSPACE },
  })
}

test('非回环请求一律 403（连音频路由也不例外）', async () => {
  const routes = buildRoutes()
  for (const path of [T.SYNTHESIZE_PATH, T.AUDIO_PATH, T.EXPORT_PATH, T.STATUS_PATH, T.CONFIG_PATH, T.VOICES_PATH, T.CANCEL_PATH]) {
    const res = makeRes()
    await routeOf(routes, path).handler(makeReq({ method: 'POST', url: path, remoteAddress: '10.0.0.5' }), res)
    assert.equal(res.state.status, 403, `${path} 应对非回环返回 403`)
  }
})

test('跨站标记被拒', async () => {
  const routes = buildRoutes()
  const res = makeRes()
  await routeOf(routes, T.STATUS_PATH).handler(makeReq({ url: T.STATUS_PATH, headers: { 'sec-fetch-site': 'cross-site' } }), res)
  assert.equal(res.state.status, 403)
})

test('synthesize 缺少 text → 400', async () => {
  const routes = buildRoutes()
  const res = makeRes()
  await routeOf(routes, T.SYNTHESIZE_PATH).handler(makeReq({ method: 'POST', url: T.SYNTHESIZE_PATH, body: { text: '   ' } }), res)
  assert.equal(res.state.status, 400)
  assert.equal(jsonOf(res).code, 'BAD_REQUEST')
})

test('synthesize 成功 → 200 且 url 是 audio 路由形态', async () => {
  const routes = buildRoutes({
    async synthesize() {
      return {
        ok: true,
        id: 'abcdef0123456789',
        url: `${T.AUDIO_PATH}/abcdef0123456789.wav`,
        ext: 'wav',
        bytes: 1234,
        ms: 5,
        cached: true,
        voice: 'mira',
        mode: 'user',
        seconds: 1.5,
        text: '你好',
        truncated: false,
      }
    },
  })
  const res = makeRes()
  await routeOf(routes, T.SYNTHESIZE_PATH).handler(
    makeReq({ method: 'POST', url: T.SYNTHESIZE_PATH, body: { text: '你好', voice: 'mira' } }),
    res,
  )
  assert.equal(res.state.status, 200)
  const body = jsonOf(res)
  assert.equal(body.ok, true)
  assert.equal(body.cached, true)
  assert.match(body.url, /^\/api\/ds-tts\/audio\/[0-9a-f]{16}\.wav$/)
})

test('synthesize 失败 → 透传结构化错误码与状态码', async () => {
  const routes = buildRoutes({
    async synthesize() {
      return { ok: false, code: 'TOO_LONG', error: '太长' }
    },
  })
  const res = makeRes()
  await routeOf(routes, T.SYNTHESIZE_PATH).handler(makeReq({ method: 'POST', url: T.SYNTHESIZE_PATH, body: { text: 'x' } }), res)
  assert.equal(res.state.status, 413)
  assert.equal(jsonOf(res).code, 'TOO_LONG')
})

test('audio 合法 id → 200 + 正确 MIME 与字节', async () => {
  const id = '0123456789abcdef'
  const bytes = T.pcmToWav(new Uint8Array(480))
  await writeFile(join(CACHE_DIR, `${id}.wav`), bytes)
  const routes = buildRoutes()
  const res = makeRes()
  await routeOf(routes, T.AUDIO_PATH).handler(makeReq({ url: `${T.AUDIO_PATH}/${id}.wav` }), res)
  assert.equal(res.state.status, 200)
  assert.equal(res.state.headers['content-type'], 'audio/wav')
  assert.equal(Buffer.from(res.state.body).length, bytes.length)
  assert.equal(String.fromCharCode(...Buffer.from(res.state.body).subarray(0, 4)), 'RIFF')
})

test('audio 非法 id / 扩展名 → 400', async () => {
  const routes = buildRoutes()
  for (const bad of [`${T.AUDIO_PATH}/nothex.wav`, `${T.AUDIO_PATH}/0123456789abcdef.exe`, `${T.AUDIO_PATH}/short.wav`]) {
    const res = makeRes()
    await routeOf(routes, T.AUDIO_PATH).handler(makeReq({ url: bad }), res)
    assert.equal(res.state.status, 400, `${bad} 应 400`)
  }
})

test('audio 合法但文件不存在 → 404', async () => {
  const routes = buildRoutes()
  const res = makeRes()
  await routeOf(routes, T.AUDIO_PATH).handler(makeReq({ url: `${T.AUDIO_PATH}/ffffffffffffffff.wav` }), res)
  assert.equal(res.state.status, 404)
})

test('export 缺 sessionId → 400', async () => {
  const routes = buildRoutes()
  const res = makeRes()
  await routeOf(routes, T.EXPORT_PATH).handler(
    makeReq({ method: 'POST', url: T.EXPORT_PATH, body: { id: '0123456789abcdef', ext: 'wav' } }),
    res,
  )
  assert.equal(res.state.status, 400)
})

test('export 把音频真的写进工作区 .dsh/tts/ 并返回绝对路径', async () => {
  const id = 'fedcba9876543210'
  const bytes = T.pcmToWav(new Uint8Array(240))
  await writeFile(join(CACHE_DIR, `${id}.wav`), bytes)
  const routes = buildRoutes()
  const res = makeRes()
  await routeOf(routes, T.EXPORT_PATH).handler(
    makeReq({ method: 'POST', url: T.EXPORT_PATH, body: { id, ext: 'wav', sessionId: 'sess-1' } }),
    res,
  )
  assert.equal(res.state.status, 200)
  const body = jsonOf(res)
  assert.equal(body.ok, true)
  assert.ok(body.path.startsWith(join(WORKSPACE, '.dsh', 'tts')), `导出路径应在工作区：${body.path}`)
  const written = await readFile(body.path)
  assert.equal(written.length, bytes.length)
  assert.equal(String.fromCharCode(...written.subarray(0, 4)), 'RIFF')
})

test('export 文件名被净化，不能逃出目录', async () => {
  const id = 'aaaabbbbccccdddd'
  await writeFile(join(CACHE_DIR, `${id}.wav`), T.pcmToWav(new Uint8Array(48)))
  const routes = buildRoutes()
  const res = makeRes()
  await routeOf(routes, T.EXPORT_PATH).handler(
    makeReq({
      method: 'POST',
      url: T.EXPORT_PATH,
      body: { id, ext: 'wav', sessionId: 'sess-1', fileName: '../../evil name.wav' },
    }),
    res,
  )
  assert.equal(res.state.status, 200)
  const body = jsonOf(res)
  assert.ok(!body.name.includes('/'), `文件名不该含路径分隔符：${body.name}`)
  assert.ok(!body.name.includes('..'), `文件名不该含上级引用：${body.name}`)
  assert.ok(body.path.startsWith(join(WORKSPACE, '.dsh', 'tts')))
})

test('config GET 返回默认值；PUT 拒绝未知键', async () => {
  const routes = buildRoutes()
  const getRes = makeRes()
  await routeOf(routes, T.CONFIG_PATH).handler(makeReq({ url: T.CONFIG_PATH }), getRes)
  assert.equal(getRes.state.status, 200)
  assert.equal(jsonOf(getRes).config.voice, DEFAULT_CONFIG.voice)
  assert.equal(jsonOf(getRes).config.format, DEFAULT_CONFIG.format)

  const badRes = makeRes()
  await routeOf(routes, T.CONFIG_PATH).handler(
    makeReq({ method: 'PUT', url: T.CONFIG_PATH, body: { nope: 1 } }),
    badRes,
  )
  assert.equal(badRes.state.status, 400)
  assert.equal(jsonOf(badRes).code, 'BAD_REQUEST')
})

test('config PUT 合法改动被持久化并能读回', async () => {
  const routes = buildRoutes()
  const putRes = makeRes()
  await routeOf(routes, T.CONFIG_PATH).handler(
    makeReq({ method: 'PUT', url: T.CONFIG_PATH, body: { voice: 'tide', mode: 'echo', maxChars: 900 } }),
    putRes,
  )
  assert.equal(putRes.state.status, 200)
  assert.equal(jsonOf(putRes).config.voice, 'tide')

  const getRes = makeRes()
  await routeOf(routes, T.CONFIG_PATH).handler(makeReq({ url: T.CONFIG_PATH }), getRes)
  const config = jsonOf(getRes).config
  assert.equal(config.voice, 'tide')
  assert.equal(config.mode, 'echo')
  assert.equal(config.maxChars, 900)
  // 未改动的项保持默认
  assert.equal(config.format, 'pcm')
})

test('config PUT 类型不对 → 400', async () => {
  const routes = buildRoutes()
  const res = makeRes()
  await routeOf(routes, T.CONFIG_PATH).handler(
    makeReq({ method: 'PUT', url: T.CONFIG_PATH, body: { maxChars: 'big' } }),
    res,
  )
  assert.equal(res.state.status, 400)
})

test('cancel 透传取消数量，方法不对给 405', async () => {
  const routes = buildRoutes({
    cancel(id) {
      return { ok: true, cancelled: id === undefined ? 2 : 1 }
    },
  })
  const res = makeRes()
  await routeOf(routes, T.CANCEL_PATH).handler(makeReq({ method: 'POST', url: T.CANCEL_PATH, body: {} }), res)
  assert.equal(jsonOf(res).cancelled, 2)

  const res2 = makeRes()
  await routeOf(routes, T.CANCEL_PATH).handler(makeReq({ method: 'GET', url: T.CANCEL_PATH }), res2)
  assert.equal(res2.state.status, 405)
})

test('status 路由可直接返回引擎快照', async () => {
  const routes = buildRoutes()
  const res = makeRes()
  await routeOf(routes, T.STATUS_PATH).handler(makeReq({ url: T.STATUS_PATH }), res)
  assert.equal(res.state.status, 200)
  assert.equal(jsonOf(res).ok, true)
})

test('voices 路由透传引擎结果', async () => {
  const routes = buildRoutes({
    async voices() {
      return { ok: true, voices: [{ id: 'mira', name: '贝壳', gender: 'female', description: '百变活泼', languages: ['zh'], isDefault: true, demoUrls: {} }], currentVoiceId: 'mira', cached: false }
    },
  })
  const res = makeRes()
  await routeOf(routes, T.VOICES_PATH).handler(makeReq({ url: T.VOICES_PATH }), res)
  assert.equal(res.state.status, 200)
  assert.equal(jsonOf(res).voices[0].id, 'mira')
})
