/**
 * Step 0 探针脚本。
 *
 * 两件事：
 *   1) 宿主侧 P4：ds-tts 从 Node（非页面）直连 chat.deepseek.com，确认 Cloudflare
 *      不拦非浏览器客户端 —— 这决定"合成能不能放宿主侧、不需要把音频经 CDP 回传"。
 *   2) 打出页面侧 P1/P2/P3 探针的用法（片段正文在 docs/probe-console.js）。
 *
 * 用法：npm run probe
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const PROBE_FILE = `${root}docs/probe-console.js`

/**
 * 探测一个 DS 接口从 Node 的可达性与错误形态。
 * @param {string} url - 目标 URL。
 * @param {'GET' | 'POST'} method - 方法。
 * @returns {Promise<void>}
 */
async function probeEndpoint(url, method) {
  const init = { method, headers: { 'Content-Type': 'application/json' } }
  if (method === 'POST') init.body = JSON.stringify({ scope: 'tts' })
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15000) })
    const text = await response.text()
    const mitigated = response.headers.get('cf-mitigated') ?? ''
    const server = response.headers.get('server') ?? ''
    console.log(`  ${method} ${url}`)
    console.log(`    HTTP ${response.status} · server=${server} · cf-mitigated=${mitigated === '' ? '(none)' : mitigated}`)
    console.log(`    body: ${text.slice(0, 200).replace(/\s+/g, ' ')}`)
    if (mitigated !== '') {
      console.log('    ⚠️ 被 Cloudflare 拦截：宿主侧直连不可行，合成必须走页面内（CDP 回传音频）')
    } else if (text.includes('INVALID_TOKEN')) {
      console.log('    ✅ 干净到达应用层（只是没有 token）→ 宿主侧直连可行')
    }
  } catch (error) {
    console.log(`  ${method} ${url}`)
    console.log(`    ❌ 网络失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('=== ds-tts Step 0 · 宿主侧可达性（P4）===')
await probeEndpoint('https://chat.deepseek.com/api/v0/chat/tts/voices', 'GET')
await probeEndpoint('https://chat.deepseek.com/api/v0/auth/ticket', 'POST')

console.log('\n=== ds-tts Step 0 · 页面侧探针（P1/P2/P3，需要你操作）===')
console.log('1) 在**已登录**的 chat.deepseek.com 打开任意一个具体对话（URL 形如 /a/chat/s/<uuid>）')
console.log('2) F12 打开 DevTools → Console')
console.log(`3) 粘贴 ${PROBE_FILE} 的全部内容并回车`)
console.log('4) 把 P1a / P1b / history / P2 / P3 五行输出贴回给 ds-tts')
try {
  const body = readFileSync(PROBE_FILE, 'utf8')
  console.log(`\n（该文件共 ${body.length.toString()} 字符；下面是开头 200 字符确认你打开的是对的）`)
  console.log(body.slice(0, 200).replace(/\n/g, ' ⏎ '))
} catch {
  console.log(`\n⚠️ 没找到 ${PROBE_FILE}`)
}
