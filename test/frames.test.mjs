/**
 * 帧协议与信封解析：这几段是照着真实协议写的，错了就会"静默拿到空音频"或
 * 把服务端错误码翻成看不懂的话，所以逐条钉住。
 */
import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { T } from './helpers.mjs'

/** 按协议造一条二进制帧：4 字节大端 seq + 负载。 */
function frame(seq, payload) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(seq, 0)
  return new Uint8Array(Buffer.concat([head, Buffer.from(payload)]))
}

test('decodeFrame 解出大端 seq 与负载', () => {
  const decoded = T.decodeFrame(frame(7, [1, 2, 3]))
  assert.equal(decoded.seq, 7)
  assert.deepEqual([...decoded.payload], [1, 2, 3])
})

test('decodeFrame 对过短/空帧返回 undefined', () => {
  assert.equal(T.decodeFrame(new Uint8Array(0)), undefined)
  assert.equal(T.decodeFrame(new Uint8Array([0, 0, 0, 1])), undefined)
})

test('assembleFrames 乱序与重复 seq 都能正确拼接', () => {
  const map = new Map()
  map.set(2, new Uint8Array([3, 4]))
  map.set(0, new Uint8Array([1, 2]))
  const joined = [...T.assembleFrames(map)]
  assert.deepEqual(joined, [1, 2, 3, 4])
})

test('parseControlFrame 解析 ready / finish，非 JSON 返回 undefined', () => {
  const ready = T.parseControlFrame('{"event":"ready","format":"pcm","voice_id":"mira","audio_id":"a1","trace_id":"t1"}')
  assert.equal(ready.event, 'ready')
  assert.equal(ready.voice_id, 'mira')
  const finish = T.parseControlFrame('{"event":"finish","code":0,"msg":"success"}')
  assert.equal(finish.code, 0)
  assert.equal(T.parseControlFrame('not json'), undefined)
})

test('ackFrame 就是协议里的 ack 文本帧', () => {
  assert.deepEqual(JSON.parse(T.ackFrame(12)), { event: 'ack', received_seq: 12, played_seq: 12 })
})

test('mapDsCode 覆盖协议备忘里的 0..12 与 40003', () => {
  assert.equal(T.mapDsCode(4).code, 'DS_QUOTA')
  assert.equal(T.mapDsCode(5).code, 'DS_RATE_LIMIT')
  assert.equal(T.mapDsCode(6).code, 'NO_CONTENT')
  assert.equal(T.mapDsCode(7).code, 'UNSUPPORTED_LANGUAGE')
  assert.equal(T.mapDsCode(8).code, 'VOICE_UNSUPPORTED_LANGUAGE')
  assert.equal(T.mapDsCode(9).code, 'DS_NOT_AVAILABLE')
  assert.equal(T.mapDsCode(11).code, 'DS_FORBIDDEN')
  assert.equal(T.mapDsCode(12).code, 'CONTENT_FILTER')
  assert.equal(T.mapDsCode(40003).code, 'NOT_LOGGED_IN')
  // 未知码保留原始信息，便于排查
  assert.equal(T.mapDsCode(999, 'weird').code, 'SYNTH_FAILED')
  assert.ok(T.mapDsCode(999, 'weird').text.includes('999'))
})

test('user 模式失败后值得改用 echo 重试的码是 2/6/10', () => {
  assert.deepEqual([...T.RETRY_AS_ECHO_CODES].sort((a, b) => a - b), [2, 6, 10])
})

test('unwrapEnvelope 正常解出 biz_data', () => {
  const raw = { code: 0, data: { biz_code: 0, biz_msg: '', biz_data: { ticket: 'abc', expires_in_secs: 600 } } }
  const out = T.unwrapEnvelope(raw)
  assert.equal(out.ok, true)
  assert.equal(out.data.ticket, 'abc')
})

test('unwrapEnvelope 顶层码 40003 → NOT_LOGGED_IN', () => {
  const out = T.unwrapEnvelope({ code: 40003, msg: 'INVALID_TOKEN', data: null })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'NOT_LOGGED_IN')
})

test('unwrapEnvelope 业务码非 0 → 对应错误', () => {
  const out = T.unwrapEnvelope({ code: 0, data: { biz_code: 9, biz_msg: 'NOT_AVAILABLE', biz_data: null } })
  assert.equal(out.ok, false)
  assert.equal(out.code, 'DS_NOT_AVAILABLE')
  assert.equal(out.bizCode, 9)
})

test('parseVoices 兼容 name_i18n 字典与字符串两种形态', () => {
  const parsed = T.parseVoices({
    current_voice_id: 'mira',
    default_voice_id: 'mira',
    voices: [
      { voice_id: 'mira', name_i18n: { zh: '贝壳', en: 'Mira' }, description_i18n: { zh: '百变活泼' }, gender: 'female', languages: ['zh', 'en'], is_default: true, demo_urls: { zh: 'https://cdn/x.mp3' } },
      { voice_id: 'echo', name_i18n: '白浪', description_i18n: '明朗坚定', gender: 'male', languages: [] },
      { name_i18n: { zh: '没有 id' } },
    ],
  })
  assert.equal(parsed.voices.length, 2)
  assert.equal(parsed.voices[0].name, '贝壳')
  assert.equal(parsed.voices[0].isDefault, true)
  assert.equal(parsed.voices[0].demoUrls.zh, 'https://cdn/x.mp3')
  assert.equal(parsed.voices[1].name, '白浪')
  assert.equal(parsed.currentVoiceId, 'mira')
})

test('parseVoices 对垃圾输入返回空列表而不是抛', () => {
  assert.deepEqual(T.parseVoices(null).voices, [])
  assert.deepEqual(T.parseVoices({ voices: 'nope' }).voices, [])
})

test('sessionIdFromUrl 只认 /a/chat/s/<id>', () => {
  assert.equal(T.sessionIdFromUrl('https://chat.deepseek.com/a/chat/s/abc-123-def'), 'abc-123-def')
  assert.equal(T.sessionIdFromUrl('https://chat.deepseek.com/'), '')
})
