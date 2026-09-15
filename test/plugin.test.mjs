/**
 * 装配集成测试：用假 cordis ctx 真的跑一遍 apply()。
 *
 * 这能盖住单测盖不到的两类问题：
 *   1) defineTool 的 schema 写错 —— 注册时就会抛；
 *   2) 路由/工具的注册面写错（数量、路径、名字）。
 * 换句话说：在让你重启 dsh web 之前，先证明插件装得起来。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { dshHome } from './helpers.mjs'

const plugin = await import('../lib/index.js')

/** 造一个只记录注册动作的假 ctx。 */
function makeCtx() {
  const routes = []
  const tools = []
  const effects = []
  const ctx = {
    effect(fn, name) {
      effects.push(name)
      const disposer = fn()
      return () => {
        if (typeof disposer === 'function') disposer()
      }
    },
    get() {
      return undefined
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => undefined
      },
    },
    tools: {
      register(tool) {
        tools.push(tool)
        return () => undefined
      },
    },
  }
  return { ctx, routes, tools, effects }
}

test('插件导出面符合 loader 契约', () => {
  assert.equal(plugin.name, 'ds-tts')
  assert.deepEqual([...plugin.inject].sort(), ['tools', 'webServer'])
  assert.equal(typeof plugin.apply, 'function')
  assert.equal(typeof plugin.Config, 'function', 'Config 必须是 schemastery schema')
})

test('Config 默认值完整且类型正确', () => {
  const defaults = plugin.Config({})
  assert.equal(defaults.voice, 'mira')
  assert.equal(defaults.format, 'pcm')
  assert.equal(defaults.mode, 'echo', '实测 DS 只接受助手消息，默认必须直接走 echo')
  assert.equal(typeof defaults.maxChars, 'number')
  assert.equal(defaults.autoLaunch, true)
  assert.equal(defaults.echoVerify, true)
  assert.equal(defaults.cacheEnabled, true)
  assert.ok(defaults.echoPrompt.includes('{text}'), 'echo 模板必须带 {text} 占位符')
})

test('apply() 注册 8 条路由与 3 个工具，且能清理', () => {
  const { ctx, routes, tools, effects } = makeCtx()
  plugin.apply(ctx, plugin.Config({}))

  assert.equal(routes.length, 8, `路由数量应为 8，实际 ${String(routes.length)}`)
  assert.equal(tools.length, 3, `工具数量应为 3，实际 ${String(tools.length)}`)

  const paths = routes.map((route) => route.path).sort()
  assert.deepEqual(paths, [
    '/api/ds-tts/audio',
    '/api/ds-tts/cancel',
    '/api/ds-tts/config',
    '/api/ds-tts/export',
    '/api/ds-tts/status',
    '/api/ds-tts/synthesize',
    '/api/ds-tts/voice',
    '/api/ds-tts/voices',
  ])
  // audio 必须是 prefix，其余 exact
  for (const route of routes) {
    assert.equal(route.kind, route.path === '/api/ds-tts/audio' ? 'prefix' : 'exact', `${route.path} 的 kind 不对`)
    assert.equal(typeof route.handler, 'function')
  }

  const names = tools.map((tool) => tool.name).sort()
  assert.deepEqual(names, ['tts_speak', 'tts_status', 'tts_voices'])
  for (const tool of tools) {
    assert.equal(typeof tool.execute, 'function', `${String(tool.name)} 缺 execute`)
    assert.ok(tool.description !== undefined && tool.description.length > 20, `${String(tool.name)} 的描述太短`)
  }

  assert.ok(effects.includes('ds-tts: http routes'))
  assert.ok(effects.includes('ds-tts: tools'))
})

test('apply() 的 DSH_HOME 指向隔离目录（绝不碰真实 ~/.dsh）', () => {
  assert.ok(dshHome.includes('ds-tts-test-'), `DSH_HOME 应为临时目录，实际 ${dshHome}`)
  assert.equal(process.env.DSH_HOME, dshHome)
})
