/**
 * 投递模式决策。
 *
 * 这是把一条**实测结论**钉进代码：DS 官方 TTS 对助手消息返回 `code 0`，
 * 对用户消息返回 `code 6 / no_content`。所以默认必须直接走 echo，
 * 否则每次首次合成都白跑一轮、还在用户会话里留一条垃圾消息。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { T } from './helpers.mjs'

test('默认模式是 echo（实测 DS 只接受助手消息）', () => {
  assert.equal(T.Config({}).mode, 'echo', 'auto 会先试 user，白跑一轮并污染会话')
})

test('echo：只走 echo', () => {
  assert.deepEqual([...T.resolveAttemptOrder('echo', null)], ['echo'])
  assert.deepEqual([...T.resolveAttemptOrder('echo', true)], ['echo'])
  assert.deepEqual([...T.resolveAttemptOrder('echo', false)], ['echo'])
})

test('user：只试 user（失败就报错，用于将来验证 DS 是否已支持）', () => {
  assert.deepEqual([...T.resolveAttemptOrder('user', null)], ['user'])
  assert.deepEqual([...T.resolveAttemptOrder('user', true)], ['user'])
  assert.deepEqual([...T.resolveAttemptOrder('user', false)], ['user'])
})

test('auto：未验证时先试 user 再降级；已知不可用就直接 echo', () => {
  assert.deepEqual([...T.resolveAttemptOrder('auto', null)], ['user', 'echo'], '自我发现路径')
  assert.deepEqual([...T.resolveAttemptOrder('auto', true)], ['user', 'echo'])
  assert.deepEqual([...T.resolveAttemptOrder('auto', false)], ['echo'], '已经验证过不可用就别再白跑')
})

test('每种模式都至少给出一个可执行项（引擎取 order[0] 不会踩空）', () => {
  for (const mode of ['echo', 'user', 'auto']) {
    for (const supported of [null, true, false]) {
      assert.ok(T.resolveAttemptOrder(mode, supported).length > 0, `${mode}/${String(supported)} 不该为空`)
    }
  }
})

test('DS 业务码 6（no_content，实测 user 消息的返回）计入"值得改用 echo 重试"', () => {
  assert.ok([...T.RETRY_AS_ECHO_CODES].includes(6))
})
