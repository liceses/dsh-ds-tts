/**
 * 页面选择与就绪判定 —— "登录完还说没登录"这个 bug 的两块可测拼图。
 *
 * 背景（实测）：`/json/new` 返回时新标签页往往还在 `about:blank`，此时访问
 * `localStorage` 会抛 SecurityError。早先的实现 attach 后立刻读 token，
 * 于是把"页面还没导航"误判成"未登录"。另外旧逻辑在没有专用会话时**每次都开新标签页**，
 * 失败三次就堆三个 `chat.deepseek.com` 标签页，而且放着它自己刚打开的那个页面不用。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { T } from './helpers.mjs'

/** 造一个可连接的 CDP 页面 target。 */
function page(url, id = url) {
  return { id, type: 'page', url, title: '', webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}` }
}

test('isDsUrl 只认 chat.deepseek.com', () => {
  assert.equal(T.isDsUrl('https://chat.deepseek.com/'), true)
  assert.equal(T.isDsUrl('https://chat.deepseek.com/a/chat/s/abc-123'), true)
  assert.equal(T.isDsUrl('https://chat.deepseek.com.evil.example/'), false, '后缀伪装不算')
  assert.equal(T.isDsUrl('https://example.com/?x=chat.deepseek.com'), false)
  assert.equal(T.isDsUrl('about:blank'), false)
  assert.equal(T.isDsUrl(''), false)
})

test('dsOriginReady：必须同时满足 DS 源 + 加载完成 + localStorage 可用', () => {
  assert.equal(T.dsOriginReady('https://chat.deepseek.com/', 'complete', true), true)
  // 这三条正是曾经误判"未登录"的三种情形
  assert.equal(T.dsOriginReady('about:blank', 'complete', false), false, '还在 about:blank')
  assert.equal(T.dsOriginReady('https://chat.deepseek.com/', 'loading', true), false, '还没加载完')
  assert.equal(T.dsOriginReady('https://chat.deepseek.com/', 'complete', false), false, 'localStorage 不可用')
  assert.equal(T.dsOriginReady('https://other.example/', 'complete', true), false, '别的源')
})

test('chooseWorkTarget：有专用会话且在开着 → 复用它', () => {
  const targets = [page('https://chat.deepseek.com/'), page('https://chat.deepseek.com/a/chat/s/sess-42')]
  const plan = T.chooseWorkTarget(targets, 'sess-42')
  assert.equal(plan.kind, 'reuse')
  assert.ok(plan.target.url.includes('sess-42'))
})

test('chooseWorkTarget：有专用会话但没开 → 直达该会话 URL', () => {
  const plan = T.chooseWorkTarget([page('https://chat.deepseek.com/')], 'sess-42')
  assert.equal(plan.kind, 'open')
  assert.equal(plan.url, 'https://chat.deepseek.com/a/chat/s/sess-42')
})

test('chooseWorkTarget：没有专用会话但已开着 DS 页面 → 复用（不再堆新标签页）', () => {
  const plan = T.chooseWorkTarget([page('https://chat.deepseek.com/')], '')
  assert.equal(plan.kind, 'reuse', '这正是旧逻辑的毛病：它每次都 openCdpTarget')
  assert.equal(plan.target.url, 'https://chat.deepseek.com/')
})

test('chooseWorkTarget：一个 DS 页面都没有才开新页', () => {
  const plan = T.chooseWorkTarget([], '')
  assert.equal(plan.kind, 'open')
  assert.equal(plan.url, 'https://chat.deepseek.com/')
})

test('chooseWorkTarget：忽略非 DS 页面、非 page 类型、以及不可连接的目标', () => {
  const targets = [
    { id: 'w', type: 'worker', url: 'https://chat.deepseek.com/', webSocketDebuggerUrl: 'ws://x' },
    page('https://example.com/'),
    { id: 'n', type: 'page', url: 'https://chat.deepseek.com/', webSocketDebuggerUrl: undefined },
  ]
  const plan = T.chooseWorkTarget(targets, '')
  assert.equal(plan.kind, 'open', '这些都不该被当成可复用的 DS 页面')
})

test('chooseWorkTarget：多个 DS 页面时取最后一个（最近打开的）', () => {
  const plan = T.chooseWorkTarget([page('https://chat.deepseek.com/', 'a'), page('https://chat.deepseek.com/a/chat/s/x', 'b')], '')
  assert.equal(plan.kind, 'reuse')
  assert.equal(plan.target.id, 'b')
})
