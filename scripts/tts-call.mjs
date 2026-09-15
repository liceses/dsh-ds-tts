#!/usr/bin/env node
/**
 * ds-tts 的命令行调用示例 —— **只打 HTTP 接口，不 import 插件任何内部代码**。
 *
 * 存在的意义：证明"文本进、音频出"这件事可以不经过 GUI。它同时也是接口的最小用法文档。
 *
 * 前置条件：
 *   - `dsh web` 在跑（默认 127.0.0.1:3080）
 *   - **首次合成**需要 DS 专用浏览器在运行且已登录 chat.deepseek.com；
 *     命中缓存时两者都不需要（纯读文件）
 *   - 接口是**仅回环**的：本机脚本可以，别的机器不行
 *
 * 用法：
 *   node scripts/tts-call.mjs "要朗读的文字"
 *   node scripts/tts-call.mjs "文字" --voice tide --out out.wav
 *   node scripts/tts-call.mjs "文字" --regen          # 强制重新合成一版
 *   node scripts/tts-call.mjs "文字" --json           # 只吐原始 JSON，方便脚本接
 *   node scripts/tts-call.mjs --status                # 先看环境是否就绪
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'

/** 极简参数解析。 */
function parseArgs(argv) {
  const out = { text: '', voice: '', mode: '', regen: false, json: false, status: false, base: 'http://127.0.0.1:3080', out: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--voice') out.voice = argv[++i] ?? ''
    else if (arg === '--mode') out.mode = argv[++i] ?? ''
    else if (arg === '--base') out.base = argv[++i] ?? out.base
    else if (arg === '--out' || arg === '-o') out.out = argv[++i] ?? ''
    else if (arg === '--regen' || arg === '--regenerate') out.regen = true
    else if (arg === '--json') out.json = true
    else if (arg === '--status') out.status = true
    else if (arg === '--help' || arg === '-h') out.help = true
    else if (!arg.startsWith('-')) out.text = out.text === '' ? arg : `${out.text} ${arg}`
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (args.help === true || (args.status !== true && args.text === '')) {
  console.log(`ds-tts 命令行调用

用法:
  node scripts/tts-call.mjs "要朗读的文字" [选项]

选项:
  --voice <id>    音色：mira(贝壳/默认) echo(白浪) stella(海星) tide(暗潮)
  --mode <m>      投递模式：echo(默认) auto user
  --regen         强制重新生成一版（DS 每次合成的声音可能不同）
  --out <path>    把音频写到该文件（否则只打印 URL）
  --json          只输出原始 JSON
  --base <url>    宿主地址，默认 http://127.0.0.1:3080
  --status        查看浏览器/登录/缓存状态后退出

注意：合成需要 DS 专用浏览器在跑且已登录；命中缓存时不需要。接口仅回环可调。`)
  process.exit(args.help === true ? 0 : 2)
}

const base = args.base.replace(/\/+$/, '')

/** 打一次 JSON 接口。 */
async function call(path, init) {
  const res = await fetch(base + path, init)
  const text = await res.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error(`返回了非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`)
  }
  return { status: res.status, body }
}

if (args.status === true) {
  try {
    const { body } = await call('/api/ds-tts/status')
    console.log(JSON.stringify(body, null, 2))
    process.exit(body.ok === true ? 0 : 1)
  } catch (error) {
    console.error(`无法访问 ${base}：${error.message}`)
    console.error('提示：先确认 `dsh web` 在跑。')
    process.exit(1)
  }
}

let result
try {
  const { status, body } = await call('/api/ds-tts/synthesize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: args.text,
      ...(args.voice !== '' ? { voice: args.voice } : {}),
      ...(args.mode !== '' ? { mode: args.mode } : {}),
      ...(args.regen ? { regenerate: true } : {}),
    }),
  })
  result = body
  if (body.ok !== true) {
    if (args.json === true) console.log(JSON.stringify(body, null, 2))
    else console.error(`合成失败（HTTP ${status} / ${body.code ?? '?'}）：${body.error ?? '未知错误'}${body.detail === undefined ? '' : `\n  细节：${body.detail}`}`)
    process.exit(1)
  }
} catch (error) {
  console.error(`请求失败：${error.message}`)
  console.error('提示：接口仅回环可调；确认 `dsh web` 在跑，且用的是本机。')
  process.exit(1)
}

if (args.json === true && args.out === '') {
  console.log(JSON.stringify(result, null, 2))
} else {
  const secs = typeof result.seconds === 'number' && result.seconds > 0 ? `${result.seconds.toFixed(1)} 秒` : '时长未知'
  console.log(`ok  ${result.ext}  ${(result.bytes / 1024).toFixed(1)} KB  ${secs}  ${result.cached === true ? '缓存命中' : result.regenerated === true ? '重新生成' : '新合成'}`)
  console.log(`音色 ${result.voice}  模式 ${result.mode}  版本 ${result.version}`)
  console.log(`url  ${base}${result.url}`)
}

if (args.out !== '') {
  let target = resolve(args.out)
  // 以分隔符结尾或没有扩展名 → 当作目录，用接口给的扩展名生成文件名
  if (target.endsWith('/') || target.endsWith('\\') || extname(target) === '') {
    target = resolve(target, `ds-tts-${result.id}.${result.ext}`)
  }
  await mkdir(dirname(target), { recursive: true })
  const res = await fetch(base + result.url)
  if (!res.ok) {
    console.error(`取音频失败：HTTP ${res.status}`)
    process.exit(1)
  }
  await writeFile(target, Buffer.from(await res.arrayBuffer()))
  console.log(`写出 ${target}`)
}
