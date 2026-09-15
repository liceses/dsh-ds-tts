/**
 * 会话历史行的解释层：字段名是逆向来的、没有文档，所以这里把"各种可能的形态"
 * 都钉成用例 —— 实测一旦发现新形态，加一条别名或一条用例即可，不用改流程代码。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { T } from './helpers.mjs'

test('标准形态：message_id + role + content', () => {
  const row = T.normalizeHistoryRow({ message_id: 'm1', role: 'assistant', content: '你好' })
  assert.deepEqual({ id: row.id, role: row.role, content: row.content }, { id: 'm1', role: 'assistant', content: '你好' })
})

test('角色大小写与别名都能归一化', () => {
  assert.equal(T.normalizeHistoryRow({ message_id: 'a', role: 'USER', content: 'x' }).role, 'user')
  assert.equal(T.normalizeHistoryRow({ message_id: 'b', role: 'Assistant', content: 'x' }).role, 'assistant')
  assert.equal(T.normalizeHistoryRow({ message_id: 'c', role: 'REQUEST', content: 'x' }).role, 'user')
  assert.equal(T.normalizeHistoryRow({ message_id: 'd', role: 'RESPONSE', content: 'x' }).role, 'assistant')
  assert.equal(T.normalizeHistoryRow({ message_id: 'e', role: 'system', content: 'x' }).role, 'other')
})

test('id 与角色的键名有多个候选', () => {
  const a = T.normalizeHistoryRow({ id: 'id-1', type: 'RESPONSE', text: 't' })
  assert.equal(a.id, 'id-1')
  assert.equal(a.role, 'assistant')
  assert.equal(a.content, 't')

  const b = T.normalizeHistoryRow({ messageId: 'mid', sender: 'user', body: 'b' })
  assert.equal(b.id, 'mid')
  assert.equal(b.role, 'user')
  assert.equal(b.content, 'b')

  const c = T.normalizeHistoryRow({ msg_id: 42, role: 'user', content: 'n' })
  assert.equal(c.id, '42')
})

test('content 是块数组时拼接文本', () => {
  const row = T.normalizeHistoryRow({
    message_id: 'm',
    role: 'assistant',
    content: [{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }, { type: 'image' }],
  })
  assert.equal(row.content, '第一段\n第二段')
})

test('content 藏在 parts / fragments / children 里也能抽出来', () => {
  assert.equal(T.normalizeHistoryRow({ message_id: 'm', role: 'assistant', parts: [{ text: 'p' }] }).content, 'p')
  assert.equal(T.normalizeHistoryRow({ message_id: 'm', role: 'assistant', fragments: ['f1', 'f2'] }).content, 'f1\nf2')
  assert.equal(T.normalizeHistoryRow({ message_id: 'm', role: 'assistant', content: { text: 'obj' } }).content, 'obj')
})

test('连 id 都取不到的行被丢弃', () => {
  assert.equal(T.normalizeHistoryRow({ role: 'user', content: 'x' }), undefined)
  assert.equal(T.normalizeHistoryRow(null), undefined)
  assert.equal(T.normalizeHistoryRow('nope'), undefined)
  assert.deepEqual(T.normalizeHistoryRows([{ role: 'user' }, { message_id: 'ok', role: 'user', content: 'x' }]).map((m) => m.id), ['ok'])
})

test('describeHistoryRows 报出真实字段名与角色取值（诊断用）', () => {
  const info = T.describeHistoryRows([
    { message_id: 'a', role: 'USER', content: '1' },
    { message_id: 'b', role: 'ASSISTANT', content: '2' },
  ])
  assert.equal(info.count, 2)
  assert.ok(info.keys.includes('message_id'))
  assert.deepEqual([...info.roles].sort(), ['ASSISTANT', 'USER'])
  assert.deepEqual(T.describeHistoryRows([]), { count: 0, keys: [], roles: [], statuses: [] })
})

test('pickNewMessage 跳过基线里的旧消息', () => {
  const messages = [
    { id: 'old', role: 'user', rawRole: 'user', content: '旧' },
    { id: 'new', role: 'user', rawRole: 'user', content: '新' },
  ]
  const picked = T.pickNewMessage(messages, { baselineIds: new Set(['old']), role: 'user' })
  assert.equal(picked.id, 'new')
})

test('pickNewMessage 按角色过滤，取最新一条', () => {
  const messages = [
    { id: 'u1', role: 'user', rawRole: 'user', content: '我的话' },
    { id: 'a1', role: 'assistant', rawRole: 'assistant', content: '模型的回答' },
    { id: 'a2', role: 'assistant', rawRole: 'assistant', content: '模型的第二段' },
  ]
  assert.equal(T.pickNewMessage(messages, { baselineIds: new Set(), role: 'assistant' }).id, 'a2')
  assert.equal(T.pickNewMessage(messages, { baselineIds: new Set(), role: 'user' }).id, 'u1')
})

test('pickNewMessage 在 user 模式下优先文本指纹命中（避免读到模型回复）', () => {
  const messages = [
    { id: 'u1', role: 'user', rawRole: 'user', content: '这是一段很长的原文内容，用于测试匹配。' },
    { id: 'a1', role: 'user', rawRole: 'user', content: '别的什么话' },
  ]
  const picked = T.pickNewMessage(messages, { baselineIds: new Set(), role: 'user', matchText: '这是一段很长的原文内容，用于测试匹配。' })
  assert.equal(picked.id, 'u1')
})

test('pickNewMessage 没有候选时返回 undefined（而不是随便挑一条）', () => {
  const messages = [{ id: 'a', role: 'assistant', rawRole: 'assistant', content: 'x' }]
  assert.equal(T.pickNewMessage(messages, { baselineIds: new Set(['a']), role: 'assistant' }), undefined)
  assert.equal(T.pickNewMessage(messages, { baselineIds: new Set(), role: 'user' }), undefined)
})

test('正文缺失时仍算候选（合成只需 message_id，服务端自己取正文）', () => {
  const picked = T.pickNewMessage(
    [{ id: 'b', role: 'user', rawRole: 'user', content: '   ' }],
    { baselineIds: new Set(), role: 'user' },
  )
  assert.equal(picked && picked.id, 'b', '历史不给正文也必须能朗读，否则功能直接不可用')
})

test('有正文的候选优先于没正文的候选', () => {
  const messages = [
    { id: 'no-content', role: 'user', rawRole: 'user', content: '' },
    { id: 'has-content', role: 'user', rawRole: 'user', content: '正文' },
  ]
  assert.equal(T.pickNewMessage(messages, { baselineIds: new Set(), role: 'user' }).id, 'has-content')
})

test('全都没正文时取最新一条，且不因 matchText 而找不到', () => {
  const messages = [
    { id: 'u1', role: 'user', rawRole: 'user', content: '' },
    { id: 'u2', role: 'user', rawRole: 'user', content: '' },
  ]
  const picked = T.pickNewMessage(messages, { baselineIds: new Set(), role: 'user', matchText: '随便什么' })
  assert.equal(picked.id, 'u2')
})
