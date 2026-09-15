/**
 * 「重新生成」与「可 API 调用」的守卫。
 *
 * 两块内容：
 *   1) 重新生成的核心行为 —— 必须跳过缓存读取，且必须换 URL 版本令牌
 *      （否则 immutable 的浏览器缓存会让新音频"看不见"，功能等于没做）；
 *   2) 接口面 —— HTTP 路由、工具参数、UI 按钮都真的接上了。
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { T, jsonOf, makeReq, makeRes, routeOf, stubEngine } from './helpers.mjs'

const READ = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8')

test('shouldReadCache：regenerate 必须跳过缓存读取', () => {
  assert.equal(T.shouldReadCache(true, false), true, '普通朗读该走缓存（秒回）')
  assert.equal(T.shouldReadCache(true, true), false, '★ 重新生成必须跳过缓存，否则会秒回旧音频')
  assert.equal(T.shouldReadCache(false, false), false, '缓存关掉时本来就不读')
  assert.equal(T.shouldReadCache(false, true), false)
})

test('audioVersion：优先用 DS 的 audio_id，缺失时退到时间戳且仍非空', () => {
  const id = 'a660c9cc-2242-4ab4-a024-1bc4a859f83e'
  assert.equal(T.audioVersion(id, 1789401696910), id)
  assert.equal(T.audioVersion('', 1789401696910), T.audioVersion(undefined, 1789401696910))
  const fallback = T.audioVersion(undefined, 1789401696910)
  assert.ok(fallback.length > 0, '退路也必须给出版本串')
  assert.notEqual(T.audioVersion(undefined, 1789401696910), T.audioVersion(undefined, 1789401697000), '不同写入时间要给不同版本')
})

test('audioUrlWithVersion：URL 必须带 ?v=，且版本被编码', () => {
  const url = T.audioUrlWithVersion('242ecfe53dbe9e8e', 'wav', 'a660c9cc-2242-4ab4-a024-1bc4a859f83e')
  assert.equal(url, '/api/ds-tts/audio/242ecfe53dbe9e8e.wav?v=a660c9cc-2242-4ab4-a024-1bc4a859f83e')
  // 版本里出现特殊字符时不能把 URL 拼坏
  const weird = T.audioUrlWithVersion('242ecfe53dbe9e8e', 'mp3', 'a b&c=d')
  assert.ok(weird.includes('?v=a%20b%26c%3Dd'), `特殊字符应被编码：${weird}`)
})

test('两个版本不同的音频 → 两个不同的 URL（这就是浏览器不吃旧缓存的原因）', () => {
  const v1 = T.audioVersion('take-1', 1)
  const v2 = T.audioVersion('take-2', 2)
  const u1 = T.audioUrlWithVersion('242ecfe53dbe9e8e', 'wav', v1)
  const u2 = T.audioUrlWithVersion('242ecfe53dbe9e8e', 'wav', v2)
  assert.notEqual(u1, u2, '同一个内容哈希 + 不同版本 → URL 必须不同')
  assert.ok(u1.includes('242ecfe53dbe9e8e'), '文件 id 不变（覆盖式：一个文本一个槽位）')
})

/* ───────────────────────── HTTP 接口面 ───────────────────────── */

const CACHE_DIR = await mkdtemp(join(tmpdir(), 'ds-tts-regen-'))

/** 用真实 ConfigStore + stub 引擎构造路由（与 routes.test 同款）。 */
function buildRoutes(engineOverrides = {}) {
  const store = new T.ConfigStore(T.Config({}))
  return T.makeRoutes({
    engine: stubEngine(engineOverrides),
    config: { view: () => store.view(), patch: (patch) => store.patch(patch) },
    cacheDir: CACHE_DIR,
  })
}

test('POST /synthesize 把 regenerate 透传给引擎（接口层面就能要求重新生成）', async () => {
  let seen
  const routes = buildRoutes({
    async synthesize(request) {
      seen = request
      return {
        ok: true,
        id: 'abcdef0123456789',
        url: T.audioUrlWithVersion('abcdef0123456789', 'wav', 'v1'),
        version: 'v1',
        regenerated: true,
        ext: 'wav',
        bytes: 123,
        ms: 5,
        cached: false,
        voice: 'mira',
        mode: 'echo',
        seconds: 1,
        text: 'x',
        truncated: false,
      }
    },
  })
  const res = makeRes()
  await routeOf(routes, T.SYNTHESIZE_PATH).handler(
    makeReq({ method: 'POST', url: T.SYNTHESIZE_PATH, body: { text: '你好', regenerate: true } }),
    res,
  )
  assert.equal(res.state.status, 200)
  assert.equal(seen.regenerate, true, '★ regenerate 必须从 body 透传到引擎')
  const body = jsonOf(res)
  assert.equal(body.regenerated, true)
  assert.ok(typeof body.version === 'string' && body.version.length > 0, '响应必须带 version')
})

test('不带 regenerate 时不会凭空出现这个字段（默认仍是走缓存）', async () => {
  let seen
  const routes = buildRoutes({ async synthesize(request) { seen = request; return { ok: false, code: 'SYNTH_FAILED', error: 'stop here' } } })
  const res = makeRes()
  await routeOf(routes, T.SYNTHESIZE_PATH).handler(makeReq({ method: 'POST', url: T.SYNTHESIZE_PATH, body: { text: '你好' } }), res)
  assert.equal(seen.regenerate, undefined, '没要求就不要设 regenerate')
})

test('音频路由忽略 ?v= 查询串（版本只用于浏览器缓存击穿）', async () => {
  const id = 'ffffffffffffffff'
  await writeFile(join(CACHE_DIR, `${id}.wav`), T.pcmToWav(new Uint8Array(48)))
  const routes = buildRoutes()
  const res = makeRes()
  await routeOf(routes, T.AUDIO_PATH).handler(makeReq({ url: `${T.AUDIO_PATH}/${id}.wav?v=take-2` }), res)
  assert.equal(res.state.status, 200, '带版本参数仍应正常返回音频')
  assert.equal(res.state.headers['content-type'], 'audio/wav')
  assert.equal(String.fromCharCode(...Buffer.from(res.state.body).subarray(0, 4)), 'RIFF')
})

/* ───────────────────────── UI / 工具接线 ───────────────────────── */

test('工具 tts_speak 暴露 regenerate 参数，并在结果里回版本', () => {
  const src = READ('src/tools.ts')
  assert.ok(/regenerate:\s*\{[\s\S]{0,200}type: 'boolean'/.test(src), 'tts_speak 应有 regenerate 布尔参数')
  assert.ok(/args\.regenerate === true \? \{ regenerate: true \}/.test(src), 'regenerate 应透传到引擎')
  assert.ok(/regenerated: \{ type: 'boolean'/.test(src), '输出 schema 应含 regenerated')
  assert.ok(/version: \{ type: 'string'/.test(src), '输出 schema 应含 version')
})

test('消息行动作行注册了重新生成 cell（order 52）', () => {
  const src = READ('src/client/index.ts')
  assert.ok(/id: 'ds-tts-regen', order: 52/.test(src), '应有 ds-tts-regen cell')
  assert.ok(/RegenerateAction/.test(src), '应导入 RegenerateAction')
})

test('重新生成按钮用官方 IconRefreshOutline16，且与朗读互斥 loading', () => {
  const ui = READ('src/client/ui.tsx')
  assert.ok(/export function RegenerateAction/.test(ui), '应有 RegenerateAction 组件')
  assert.ok(/<IconRefresh \/>/.test(ui), '应使用 IconRefresh（官方 IconRefreshOutline16）')
  const icons = READ('src/client/icons.tsx')
  assert.ok(/pick\('IconRefreshOutline16'/.test(icons), 'IconRefresh 应取官方 IconRefreshOutline16 并带兜底')
  assert.ok(/state\.activeKind === 'regen'/.test(ui), '重新生成按钮要按 activeKind 判断自己是否在跑')
  assert.ok(/state\.activeKind === 'speak'/.test(ui), '朗读按钮同理——否则点 ⟳ 时 🔊 也会转圈')
})

test('弹窗底部有「重新生成」，且主行动仍然唯一实底', () => {
  const ui = READ('src/client/ui.tsx')
  const cssStart = ui.indexOf('export const CSS = `')
  const foot = ui.slice(ui.indexOf('ds-tts-modal-foot'), cssStart)
  assert.ok(/重新生成/.test(foot), '弹窗底部应有「重新生成」')
  assert.ok(/regenerate: true/.test(foot), '它应真的请求重新生成')
  assert.equal((foot.match(/ds-tts-btn--primary/g) ?? []).length, 1, '主行动只能有一个')
})

test('actions 用选项对象承载 regenerate（不再堆位置参数）', () => {
  const src = READ('src/client/actions.ts')
  assert.ok(/export interface MakeAudioOptions/.test(src), '应有 MakeAudioOptions')
  assert.ok(/regenerate\?: boolean/.test(src), '选项里应有 regenerate')
  assert.ok(/regenerate \? \{ regenerate: true \}/.test(src), '应把 regenerate 交给接口')
  assert.ok(/activeKind/.test(src), '进度状态里应带 activeKind')
})
