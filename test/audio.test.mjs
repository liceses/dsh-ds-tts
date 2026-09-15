/**
 * 音频容器与内容寻址缓存。
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { T } from './helpers.mjs'

test('pcmToWav 产出的头字段完全符合 44 字节 WAV 规范', () => {
  const pcm = new Uint8Array(2400) // 24000Hz * 2 bytes * 0.05s
  const wav = T.pcmToWav(pcm)
  assert.equal(wav.length, 44 + 2400)
  const text = (start, end) => String.fromCharCode(...wav.subarray(start, end))
  assert.equal(text(0, 4), 'RIFF')
  assert.equal(text(8, 12), 'WAVE')
  assert.equal(text(12, 16), 'fmt ')
  assert.equal(text(36, 40), 'data')
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength)
  assert.equal(view.getUint32(4, true), 36 + 2400, 'RIFF size')
  assert.equal(view.getUint32(16, true), 16, 'fmt chunk size')
  assert.equal(view.getUint16(20, true), 1, 'PCM format tag')
  assert.equal(view.getUint16(22, true), 1, 'mono')
  assert.equal(view.getUint32(24, true), 24000, '24kHz')
  assert.equal(view.getUint32(28, true), 48000, 'byte rate')
  assert.equal(view.getUint16(32, true), 2, 'block align')
  assert.equal(view.getUint16(34, true), 16, 'bits per sample')
  assert.equal(view.getUint32(40, true), 2400, 'data size')
})

test('pcmDurationSeconds 按 24kHz/mono/16bit 换算', () => {
  assert.equal(T.pcmDurationSeconds(48000), 1)
  assert.equal(T.pcmDurationSeconds(0), 0)
})

test('wavDurationSeconds 从头部读回时长', () => {
  const wav = T.pcmToWav(new Uint8Array(48000))
  assert.equal(T.wavDurationSeconds(wav), 1)
})

test('probeAudioMagic 认 WAV / MP3(ID3 与帧同步) / Ogg', () => {
  assert.equal(T.probeAudioMagic(T.pcmToWav(new Uint8Array(10))), 'wav')
  assert.equal(T.probeAudioMagic(new Uint8Array([0x49, 0x44, 0x33, 1])), 'mp3')
  assert.equal(T.probeAudioMagic(new Uint8Array([0xff, 0xfb, 0x90, 0x00])), 'mp3')
  assert.equal(T.probeAudioMagic(new Uint8Array([0x4f, 0x67, 0x67, 0x53])), 'opus')
  assert.equal(T.probeAudioMagic(new Uint8Array([1, 2, 3, 4])), 'unknown')
})

test('isOggContainer 区分 Ogg 容器与裸 Opus 包', () => {
  assert.equal(T.isOggContainer(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0])), true)
  assert.equal(T.isOggContainer(new Uint8Array([0xf8, 0xff, 0xfe])), false)
})

test('contentTypeOf 给出正确的 MIME', () => {
  assert.equal(T.contentTypeOf('wav'), 'audio/wav')
  assert.equal(T.contentTypeOf('mp3'), 'audio/mpeg')
  assert.equal(T.contentTypeOf('nope'), 'application/octet-stream')
})

test('cacheId 稳定、长度 16 且对字段顺序敏感', () => {
  const a = T.cacheId(['mira', 'pcm', '你好'])
  assert.match(a, /^[0-9a-f]{16}$/)
  assert.equal(a, T.cacheId(['mira', 'pcm', '你好']))
  assert.notEqual(a, T.cacheId(['echo', 'pcm', '你好']))
  assert.notEqual(a, T.cacheId(['pcm', 'mira', '你好']))
  // 字段边界必须无歧义：拼接不同内容不应撞 id
  assert.notEqual(T.cacheId(['ab', 'c']), T.cacheId(['a', 'bc']))
})

test('writeCache / readCache 往返，并附带元数据', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ds-tts-cache-'))
  const id = T.cacheId(['mira', 'pcm', 'hi'])
  const bytes = T.pcmToWav(new Uint8Array(96))
  const path = await T.writeCache(dir, id, 'wav', bytes, {
    voice: 'mira',
    mode: 'user',
    format: 'pcm',
    seconds: 0.001,
    text: 'hi',
    truncated: false,
  })
  assert.equal(path, join(dir, `${id}.wav`))
  const hit = await T.readCache(dir, id)
  assert.equal(hit.ext, 'wav')
  assert.equal(hit.bytes, bytes.length)
  assert.equal(hit.meta.voice, 'mira')
  assert.equal(hit.meta.mode, 'user')
  // 不存在的 id 返回 undefined
  assert.equal(await T.readCache(dir, T.cacheId(['x'])), undefined)
})

test('cacheStats 只数音频、不数 sidecar', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ds-tts-stats-'))
  await writeFile(join(dir, 'aaaaaaaaaaaaaaaa.wav'), Buffer.alloc(100))
  await writeFile(join(dir, 'aaaaaaaaaaaaaaaa.json'), '{}')
  const stats = await T.cacheStats(dir)
  assert.equal(stats.files, 1)
  assert.equal(stats.bytes, 100)
})

test('pruneCache 清理超期文件、保留新文件', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ds-tts-prune-'))
  const oldFile = join(dir, 'bbbbbbbbbbbbbbbb.wav')
  await writeFile(oldFile, Buffer.alloc(10))
  const stale = new Date(Date.now() - 40 * 24 * 3600 * 1000)
  const { utimes } = await import('node:fs/promises')
  await utimes(oldFile, stale, stale)
  await writeFile(join(dir, 'cccccccccccccccc.wav'), Buffer.alloc(10))
  const removed = await T.pruneCache(dir, 30)
  assert.equal(removed, 1)
  const remaining = await readFile(join(dir, 'cccccccccccccccc.wav'))
  assert.equal(remaining.length, 10)
})
