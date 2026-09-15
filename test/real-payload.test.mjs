/**
 * 真实报文回归夹具。
 *
 * 下面的行是**用户实测贴回来的原始 JSON**（2026-09-14，chat.deepseek.com
 * `/api/v0/chat/history_messages`）。把它们固化成测试，是因为这里有两个曾经
 * 让整个流程静默失败的坑：
 *
 *   1) `role` 是**大写** `USER` / `ASSISTANT` —— 早先的实现在页面内直接写
 *      `m.role === 'user'`，恒为 false，于是"等不到新消息"，功能整个不可用；
 *   2) `message_id` 是**数字** `1` / `2`（会话内序号），不是 UUID 字符串。
 *
 * 任何重构只要把这两条弄回去，这些用例就会红。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { T } from './helpers.mjs'

/** 实测的用户消息原文。 */
const REAL_USER_ROW = {
  message_id: 1,
  parent_id: null,
  model: '',
  role: 'USER',
  thinking_enabled: true,
  ban_edit: false,
  ban_regenerate: false,
  status: 'FINISHED',
  incomplete_message: null,
  accumulated_token_usage: 64,
  files: [],
  feedback: null,
  inserted_at: 1789389418.319,
  search_enabled: true,
  content: 'dsh有没有web端的skill管理器',
  thinking_content: null,
  thinking_elapsed_secs: null,
  search_status: null,
  search_results: null,
  tips: [],
}

/** 实测的助手消息原文（字段同构，只改关键几项）。 */
const REAL_ASSISTANT_ROW = {
  ...REAL_USER_ROW,
  message_id: 2,
  parent_id: 1,
  model: 'deepseek-v4-flash',
  role: 'ASSISTANT',
  accumulated_token_usage: 512,
  content: 'DSH(DeepSeek Harness) **原生并没有内置 Web 端的 Skill 图形化管理器**。',
}

test('实测报文：大写 role 被归一化，数字 message_id 变字符串', () => {
  const user = T.normalizeHistoryRow(REAL_USER_ROW)
  assert.equal(user.id, '1', 'message_id 是数字，必须转成字符串')
  assert.equal(user.role, 'user', '大写的 USER 必须归一成 user')
  assert.equal(user.rawRole, 'USER', '保留原始串用于诊断')
  assert.equal(user.status, 'FINISHED')
  assert.equal(user.content, 'dsh有没有web端的skill管理器')

  const assistant = T.normalizeHistoryRow(REAL_ASSISTANT_ROW)
  assert.equal(assistant.id, '2')
  assert.equal(assistant.role, 'assistant')
  assert.ok(assistant.content.startsWith('DSH(DeepSeek Harness)'))
})

test('实测报文：pickNewMessage 能挑出新的用户消息与助手消息', () => {
  const messages = T.normalizeHistoryRows([REAL_USER_ROW, REAL_ASSISTANT_ROW])
  assert.equal(messages.length, 2)

  // 基线为空 → 最新 user / assistant 各自能被挑到
  assert.equal(T.pickNewMessage(messages, { baselineIds: new Set(), role: 'user' }).id, '1')
  assert.equal(T.pickNewMessage(messages, { baselineIds: new Set(), role: 'assistant' }).id, '2')

  // 基线含两者 → 没有新消息
  assert.equal(T.pickNewMessage(messages, { baselineIds: new Set(['1', '2']), role: 'assistant' }), undefined)
})

test('实测报文：user 模式的文本指纹能精确命中（不会误读助手回复）', () => {
  const messages = T.normalizeHistoryRows([REAL_ASSISTANT_ROW, REAL_USER_ROW])
  const picked = T.pickNewMessage(messages, {
    baselineIds: new Set(),
    role: 'user',
    matchText: 'dsh有没有web端的skill管理器',
  })
  assert.equal(picked.id, '1')
})

test('实测报文：诊断能报出真实角色与状态', () => {
  const info = T.describeHistoryRows([REAL_USER_ROW, REAL_ASSISTANT_ROW])
  assert.equal(info.count, 2)
  assert.deepEqual([...info.roles].sort(), ['ASSISTANT', 'USER'])
  assert.deepEqual(info.statuses, ['FINISHED'])
  assert.ok(info.keys.includes('message_id'))
  assert.ok(info.keys.includes('thinking_content'), '字段名要与实测一致（便于一眼认出改版）')
})

test('finishedOnly 只放行已完成的消息', () => {
  assert.equal(T.isFinishedStatus('FINISHED'), true)
  assert.equal(T.isFinishedStatus('finished'), true)
  assert.equal(T.isFinishedStatus(''), true, '没有状态字段时视为可用，避免永久等待')
  assert.equal(T.isFinishedStatus('INCOMPLETE'), false)
  assert.equal(T.isFinishedStatus('GENERATING'), false)

  const streaming = { ...T.normalizeHistoryRow(REAL_ASSISTANT_ROW), status: 'INCOMPLETE' }
  const done = T.normalizeHistoryRow(REAL_USER_ROW)
  const messages = [done, streaming]
  assert.equal(
    T.pickNewMessage(messages, { baselineIds: new Set(), role: 'assistant', finishedOnly: true }),
    undefined,
    '还在生成的消息不该被取音频',
  )
  assert.equal(
    T.pickNewMessage(messages, { baselineIds: new Set(), role: 'assistant' }).id,
    '2',
    '不要求完成态时仍能拿到（供超时兜底用）',
  )
})
