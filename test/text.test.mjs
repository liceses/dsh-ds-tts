/**
 * Markdown → 口播文本的归一化：这是"读出来像不像人话"的关键，也是最容易写错的纯函数。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { T } from './helpers.mjs'

test('丢弃代码围栏，并统计段数', () => {
  const input = ['先看这段：', '```ts', 'const a = 1', '```', '然后结束。'].join('\n')
  const out = T.normalizeForSpeech(input, 5000)
  assert.equal(out.stats.codeBlocks, 1)
  assert.ok(!out.text.includes('const a = 1'), '代码内容不该被朗读')
  assert.ok(out.text.includes('先看这段'))
  assert.ok(out.text.includes('然后结束'))
})

test('未闭合的代码围栏整段丢弃', () => {
  const out = T.normalizeForSpeech('结论如下\n```py\nprint(1)\nprint(2)', 5000)
  assert.equal(out.stats.codeBlocks, 1)
  assert.ok(!out.text.includes('print'))
  assert.ok(out.text.includes('结论如下'))
})

test('链接取文本、图片与裸 URL 丢弃', () => {
  const out = T.normalizeForSpeech('见 [官方文档](https://a.example/x) 与 ![图](https://b.example/y.png) 以及 https://c.example/z', 5000)
  assert.equal(out.stats.links, 1)
  assert.equal(out.stats.images, 1)
  assert.ok(out.stats.bareUrls >= 1)
  assert.ok(out.text.includes('官方文档'))
  assert.ok(!out.text.includes('example'), 'URL 不该出现在口播文本里')
})

test('表格压平成顿号连接，分隔行丢弃', () => {
  const input = ['| 名称 | 值 |', '| --- | --- |', '| A | 1 |'].join('\n')
  const out = T.normalizeForSpeech(input, 5000)
  assert.equal(out.stats.tableRows, 3)
  assert.ok(out.text.includes('名称，值'))
  assert.ok(out.text.includes('A，1'))
  assert.ok(!out.text.includes('---'), '分隔行不该被读出来')
})

test('清掉标题/引用/列表符号与强调标记', () => {
  const input = ['## 标题', '> 引用一句话', '- **加粗**项', '1. `代码`项', '---'].join('\n')
  const out = T.normalizeForSpeech(input, 5000)
  assert.ok(!/[#>*`]/.test(out.text), `不该残留 Markdown 符号：${out.text}`)
  assert.ok(out.text.includes('标题'))
  assert.ok(out.text.includes('加粗项'))
  assert.ok(out.text.includes('代码项'))
})

test('去 emoji 与零宽字符', () => {
  const out = T.normalizeForSpeech('完成\u200B了🎉✅！', 5000)
  assert.equal(out.text, '完成了！')
})

test('超长在句末截断并标记 truncated', () => {
  const input = '第一句话。第二句话。第三句话。第四句话。'
  const out = T.normalizeForSpeech(input, 10)
  assert.equal(out.truncated, true)
  assert.ok(out.text.length <= 10, `截断后不应超过上限：${out.text}`)
  assert.ok(out.text.endsWith('。'), `应在句末截断：${out.text}`)
})

test('全代码内容归一化后为空（调用方据此报 NO_CONTENT）', () => {
  const out = T.normalizeForSpeech('```js\nconsole.log(1)\n```', 5000)
  assert.equal(out.text.trim(), '')
  assert.ok(out.originalChars > 0)
})

test('宽松指纹抹平空白与标点', () => {
  assert.equal(T.looseFingerprint('你好， 世界！\n'), T.looseFingerprint('你好世界'))
})
