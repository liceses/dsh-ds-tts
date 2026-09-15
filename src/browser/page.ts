/**
 * DS 网页驱动（CDP）：把待读文本变成 DS 会话里的一条真实消息，并取回它的 message_id。
 *
 * 这是整个插件唯一"脏"的地方，也是腿1 的全部价值所在：用**真实浏览器真行为**
 * 完成投递，于是 DeepSeekHashV1 的 PoW、Cloudflare 的 cf_clearance、浏览器 TLS
 * 指纹全部由页面自己处理，我们一行都不碰。
 *
 * 安全约定：`userToken` 只在页面上下文里读出来用于**当次**请求，宿主不落盘、不日志化。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { DsTtsErrorCode } from '../protocol.ts'
import { browserProfilePath } from '../paths.ts'
import { looseFingerprint } from '../ds/text.ts'
import {
  describeHistoryRows,
  normalizeHistoryRows,
  pickNewMessage,
  type DsHistoryMessage,
} from '../ds/history.ts'
import { CdpClient, fetchCdpVersion, listCdpTargets, openCdpTarget, type CdpTarget } from './cdp.ts'

/** DS 网页 origin。 */
const DS_ORIGIN = 'https://chat.deepseek.com'

/** 浏览器桥需要的配置子集。 */
export interface BrowserOptions {
  cdpUrl: string
  cdpPort: number
  browserPath: string
  userDataDir: string
  autoLaunch: boolean
}

/** 浏览器桥失败。 */
export interface BrowserFailure {
  ok: false
  code: DsTtsErrorCode
  error: string
  detail: string
}

/** 浏览器桥成功。 */
export interface BrowserHandle {
  ok: true
  /** CDP HTTP 端点，例如 http://127.0.0.1:9222。 */
  base: string
  /** 浏览器 product 串。 */
  browser: string
  /** 是否是 ds-tts 自己拉起的专用浏览器。 */
  launched: boolean
  /** 自启进程句柄（attached 时为 undefined）。 */
  child?: ChildProcess
}

/** 一条会话历史消息（解释层在 ds/history.ts）。 */
export type { DsHistoryMessage }

/** 投递结果。 */
export interface DeliverResult {
  ok: true
  /** 提交方式（send-button / enter-key），仅用于诊断。 */
  method: string
  /** 命中的输入框选择器。 */
  selector: string
}

/**
 * 在候选路径里找出浏览器可执行文件。
 * @param explicit - 配置里的显式路径。
 * @returns 可用路径；找不到时 undefined。
 */
function detectBrowserExecutable(explicit: string): string | undefined {
  if (explicit !== '' && existsSync(explicit)) return explicit
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const local = process.env.LOCALAPPDATA ?? ''
  const candidates = [
    join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]
  if (local !== '') {
    candidates.push(join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    candidates.push(join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'))
  }
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return undefined
}

/**
 * 确保有一个可用的 CDP 端点（优先复用，必要时按配置拉起专用浏览器）。
 * @param options - 浏览器相关配置。
 * @returns 浏览器句柄或结构化失败。
 */
export async function ensureBrowser(options: BrowserOptions): Promise<BrowserHandle | BrowserFailure> {
  // 1) 显式端点
  if (options.cdpUrl !== '') {
    const base = options.cdpUrl.replace(/\/+$/, '')
    const version = await fetchCdpVersion(base, 3000)
    if (version === undefined) {
      return {
        ok: false,
        code: 'NO_BROWSER',
        error: `配置的 CDP 端点不可达：${base}`,
        detail: '确认浏览器是以 --remote-debugging-port 启动的，或在设置里清空 cdpUrl 让 ds-tts 自动拉起专用浏览器',
      }
    }
    return { ok: true, base, browser: version.browser, launched: false }
  }

  // 2) 默认端口上已有调试端点
  const base = `http://127.0.0.1:${options.cdpPort.toString()}`
  const existing = await fetchCdpVersion(base, 2000)
  if (existing !== undefined) {
    return { ok: true, base, browser: existing.browser, launched: false }
  }

  // 3) 自启专用浏览器
  if (!options.autoLaunch) {
    return {
      ok: false,
      code: 'NO_BROWSER',
      error: `127.0.0.1:${options.cdpPort.toString()} 上没有可用的浏览器调试端点`,
      detail: 'autoLaunch 已关闭；请手动以 --remote-debugging-port 启动浏览器，或打开 autoLaunch',
    }
  }
  const executable = detectBrowserExecutable(options.browserPath)
  if (executable === undefined) {
    return {
      ok: false,
      code: 'NO_BROWSER',
      error: '没有找到 Edge / Chrome 可执行文件',
      detail: '请在设置里填写 browserPath，指向 msedge.exe 或 chrome.exe',
    }
  }
  const profileDir = options.userDataDir !== '' ? options.userDataDir : browserProfilePath()
  const child = spawn(
    executable,
    [
      `--remote-debugging-port=${options.cdpPort.toString()}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
      `${DS_ORIGIN}/`,
    ],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()

  // 等端点起来（首次冷启动可能要十几秒）
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    const version = await fetchCdpVersion(base, 1500)
    if (version !== undefined) {
      return { ok: true, base, browser: version.browser, launched: true, child }
    }
  }
  return {
    ok: false,
    code: 'NO_BROWSER',
    error: '专用浏览器已启动但调试端点始终没起来',
    detail: `已用 ${executable}（profile=${profileDir}，port=${options.cdpPort.toString()}）启动，25s 内 /json/version 无响应`,
  }
}

/**
 * 判断一个 URL 是否属于 DS 网页。
 * @param url - 待判断的 URL。
 * @returns 是否是 chat.deepseek.com 的页面。
 */
export function isDsUrl(url: string): boolean {
  try {
    return new URL(url).hostname === 'chat.deepseek.com'
  } catch {
    return false
  }
}

/**
 * 列出当前打开着的 DS 页面（只读，不打开/不导航任何标签页）。
 * @param base - CDP HTTP 端点。
 * @returns 可连接的 DS 页面 target 列表。
 */
export async function listDsPages(base: string): Promise<CdpTarget[]> {
  const targets = await listCdpTargets(base)
  return targets.filter((t) => t.type === 'page' && isDsUrl(t.url) && t.webSocketDebuggerUrl !== undefined)
}

/**
 * 选页计划：复用已有页面，还是需要新开一个。
 *
 * 抽成纯函数是为了能单测 —— 这里曾经的行为是"没有专用会话就每次开新标签页"，
 * 结果每失败一次就多堆一个标签页，而且放着它自己刚启动浏览器时打开的那个页面不用。
 */
export type WorkTargetPlan =
  | { kind: 'reuse'; target: CdpTarget }
  | { kind: 'open'; url: string }

/**
 * 决定用哪个 DS 页面。
 *
 * 优先级：① URL 带我们专用会话 id 的页面 → ② 任何已开着的 DS 页面 → ③ 才新开。
 * 只在第 ③ 种情况下才会新增标签页（绝不关闭别人的页面）。
 * @param targets - `/json/list` 给出的全部目标。
 * @param chatSessionId - ds-tts 专用会话 id（空串表示还没有）。
 * @returns 复用目标或要打开的 URL。
 */
export function chooseWorkTarget(targets: readonly CdpTarget[], chatSessionId: string): WorkTargetPlan {
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl !== undefined && isDsUrl(t.url))
  if (chatSessionId !== '') {
    const mine = pages.find((t) => t.url.includes(chatSessionId))
    if (mine !== undefined) return { kind: 'reuse', target: mine }
    return { kind: 'open', url: `${DS_ORIGIN}/a/chat/s/${chatSessionId}` }
  }
  const existing = pages[pages.length - 1]
  if (existing !== undefined) return { kind: 'reuse', target: existing }
  return { kind: 'open', url: `${DS_ORIGIN}/` }
}

/**
 * 选出/打开一个用来投递的 DS 页面。
 * @param base - CDP HTTP 端点。
 * @param chatSessionId - ds-tts 专用会话 id（空串表示需要一个新会话）。
 * @returns 页面 target 或阶段失败信息。
 */
export async function pickWorkPage(base: string, chatSessionId: string): Promise<{ ok: true; target: CdpTarget } | BrowserFailure> {
  const targets = await listCdpTargets(base)
  const plan = chooseWorkTarget(targets, chatSessionId)
  if (plan.kind === 'reuse') return { ok: true, target: plan.target }
  const opened = await openCdpTarget(base, plan.url)
  if (opened === undefined) {
    return { ok: false, code: 'NO_BROWSER', error: '无法打开 DS 页面', detail: `url=${plan.url}` }
  }
  return { ok: true, target: opened }
}

/**
 * 判断页面是否真的落在 DS 源上并且可用（纯函数，可单测）。
 *
 * 为什么需要它：`/json/new` 返回时新标签页往往还在 `about:blank`，此时
 * `localStorage` 会抛 SecurityError。早先的实现 attach 后**立刻**读 token，
 * 于是把"页面还没导航"误判成"未登录"。
 * @param href - 页面当前 URL。
 * @param readyState - `document.readyState`。
 * @param canUseLocalStorage - 在该 document 上访问 `localStorage` 是否成功。
 * @returns 是否已经可以安全地读登录态/执行投递。
 */
export function dsOriginReady(href: string, readyState: string, canUseLocalStorage: boolean): boolean {
  return isDsUrl(href) && readyState === 'complete' && canUseLocalStorage
}

/**
 * 轮询等到页面落在 DS 源上、加载完成、且 `localStorage` 可用。
 * @param client - 页面 CDP 连接。
 * @param timeoutMs - 超时毫秒。
 * @returns 就绪时的 URL；超时返回失败（detail 带实际观察到的 href，便于定位）。
 */
export async function waitForDsOrigin(
  client: CdpClient,
  timeoutMs = 20000,
): Promise<{ ok: true; href: string } | { ok: false; detail: string }> {
  const expression = `(() => {
    let ls = false
    try { localStorage.getItem('userToken'); ls = true } catch { ls = false }
    return JSON.stringify({ href: location.href, ready: document.readyState, ls })
  })()`
  const deadline = Date.now() + timeoutMs
  let lastHref = '(unknown)'
  let lastState = ''
  while (Date.now() < deadline) {
    try {
      const raw = await evaluate<string>(client, expression, { timeoutMs: 8000 })
      if (typeof raw === 'string') {
        try {
          const parsed = JSON.parse(raw) as { href?: string; ready?: string; ls?: boolean }
          lastHref = parsed.href ?? lastHref
          lastState = `${parsed.ready ?? '?'}/ls=${String(parsed.ls ?? false)}`
          if (dsOriginReady(lastHref, parsed.ready ?? '', parsed.ls === true)) {
            return { ok: true, href: lastHref }
          }
        } catch {
          // 解析失败当作还没就绪
        }
      }
    } catch (error) {
      lastState = error instanceof Error ? error.message.slice(0, 80) : String(error)
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  return {
    ok: false,
    detail: `页面未在 ${timeoutMs.toString()}ms 内就绪：href=${lastHref} state=${lastState}`,
  }
}

/** 求值辅助函数：把返回值取成 JSON。 */
async function evaluate<T>(client: CdpClient, expression: string, options: { awaitPromise?: boolean; timeoutMs?: number } = {}): Promise<T | undefined> {
  const result = await client.send<{
    result?: { value?: unknown }
    exceptionDetails?: { text?: string; exception?: { description?: string } }
  }>(
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: options.awaitPromise ?? false,
      userGesture: true,
      allowUnsafeEvalBlockedByCSP: false,
    },
    options.timeoutMs ?? 30000,
  )
  if (result.exceptionDetails !== undefined) {
    const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown'
    throw new Error(`页面脚本异常：${detail.slice(0, 300)}`)
  }
  return result.result?.value as T | undefined
}

/** 输入框探测脚本（多个候选选择器 + 可见性判断），命中后打标记便于后续操作。 */
const COMPOSER_PROBE = `(() => {
  const selectors = ['textarea[placeholder]', 'textarea', 'div[contenteditable="true"]', '[contenteditable="true"]']
  const old = document.querySelector('[data-ds-tts-composer]')
  if (old) old.removeAttribute('data-ds-tts-composer')
  for (const sel of selectors) {
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const r = el.getBoundingClientRect()
      if (r.width < 80 || r.height < 10) continue
      const style = window.getComputedStyle(el)
      if (style.visibility === 'hidden' || style.display === 'none') continue
      el.setAttribute('data-ds-tts-composer', '1')
      el.focus()
      return { sel, tag: el.tagName, editable: el.isContentEditable === true, placeholder: el.getAttribute('placeholder') || '' }
    }
  }
  return null
})()`

/** 读输入框当前文本。 */
const COMPOSER_READ = `(() => {
  const el = document.querySelector('[data-ds-tts-composer]')
  if (!el) return null
  return el.isContentEditable === true ? (el.innerText || '') : (el.value || '')
})()`

/** 尝试点发送按钮（真实 click 事件，React 会认）。 */
const SEND_BUTTON_CLICK = `(() => {
  const isVisible = (el) => { const r = el.getBoundingClientRect(); return r.width > 8 && r.height > 8 }
  const texts = ['发送', 'Send', 'send']
  const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(isVisible)
  const bySubmit = buttons.find((b) => b.getAttribute('type') === 'submit' && b.disabled !== true)
  const byLabel = buttons.find((b) => {
    if (b.disabled === true) return false
    const hay = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + (b.textContent || '')).trim()
    return texts.some((t) => hay.includes(t))
  })
  const target = byLabel || bySubmit
  if (!target) return null
  target.click()
  return ((target.getAttribute('aria-label') || target.getAttribute('title') || target.textContent || '') + '').trim().slice(0, 60)
})()`

/**
 * 读取页面登录态与 token。
 *
 * token 只在内存里返回给调用方当次使用；**不要**写进日志或配置。
 * @param client - 页面 CDP 连接。
 * @returns token（未登录为空串）。
 */
export async function readToken(client: CdpClient): Promise<string> {
  const value = await evaluate<string>(
    client,
    `(() => {
      try {
        const raw = localStorage.getItem('userToken')
        if (!raw) return ''
        const parsed = JSON.parse(raw)
        if (typeof parsed === 'string') return parsed
        if (parsed && typeof parsed.value === 'string') return parsed.value
        return ''
      } catch { return '' }
    })()`,
  )
  return typeof value === 'string' ? value : ''
}

/**
 * 读当前页面 URL。
 * @param client - 页面 CDP 连接。
 * @returns 绝对 URL（失败时为空串）。
 */
export async function readPageUrl(client: CdpClient): Promise<string> {
  const value = await evaluate<string>(client, 'location.href')
  return typeof value === 'string' ? value : ''
}

/**
 * 从 URL 里抽出 DS 会话 id。
 * @param url - 页面 URL。
 * @returns 会话 id；非会话页返回空串。
 */
export function sessionIdFromUrl(url: string): string {
  const match = /\/a\/chat\/s\/([0-9a-zA-Z-]{8,})/.exec(url)
  return match?.[1] ?? ''
}

/**
 * 等页面进入可投递状态（document 完成 + 找到输入框）。
 * @param client - 页面 CDP 连接。
 * @param timeoutMs - 超时毫秒。
 * @returns 输入框信息；超时返回 undefined。
 */
export async function waitForComposer(
  client: CdpClient,
  timeoutMs = 30000,
): Promise<{ sel: string; tag: string; editable: boolean; placeholder: string } | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const info = await evaluate<{ sel: string; tag: string; editable: boolean; placeholder: string } | null>(client, COMPOSER_PROBE, {
        timeoutMs: 8000,
      })
      if (info !== undefined && info !== null) return info
    } catch {
      // 页面还在导航，重试
    }
    await new Promise((resolve) => setTimeout(resolve, 600))
  }
  return undefined
}

/**
 * 把一段文本投递进当前 DS 会话（聚焦输入框 → 插入文本 → 校验 → 提交）。
 * @param client - 页面 CDP 连接。
 * @param text - 待投递文本。
 * @returns 投递结果或结构化失败。
 */
export async function deliverText(client: CdpClient, text: string): Promise<DeliverResult | BrowserFailure> {
  const composer = await waitForComposer(client, 30000)
  if (composer === undefined) {
    return {
      ok: false,
      code: 'DELIVER_FAILED',
      error: '在 DS 页面里找不到输入框',
      detail: '可能是 DS 前端改版或页面未加载完成；可在状态页确认页面 URL 是否正确',
    }
  }

  // 真实输入管线：React 受控组件只有走这里才会更新状态
  await client.send('Input.insertText', { text }, 20000)

  const typed = await evaluate<string | null>(client, COMPOSER_READ)
  const expected = looseFingerprint(text)
  const actual = looseFingerprint(typeof typed === 'string' ? typed : '')
  if (actual === '' || !actual.includes(expected.slice(0, Math.min(60, expected.length)))) {
    return {
      ok: false,
      code: 'DELIVER_FAILED',
      error: '文本没有真正进入 DS 输入框',
      detail: `selector=${composer.sel} 读到 ${String(typeof typed === 'string' ? typed.length : -1)} 字符`,
    }
  }

  // 优先点发送按钮；找不到就发 Enter
  const clicked = await evaluate<string | null>(client, SEND_BUTTON_CLICK, { timeoutMs: 10000 })
  if (typeof clicked === 'string' && clicked !== '') {
    return { ok: true, method: `send-button:${clicked}`, selector: composer.sel }
  }
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
    text: '\r',
  })
  await client.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  })
  return { ok: true, method: 'enter-key', selector: composer.sel }
}

/**
 * 在页面上下文里取会话历史。
 *
 * 页面只负责**取原始行**（截断内容、只留最近若干条以限制 CDP 负载）；
 * 字段解释全部交给宿主侧的 ds/history.ts —— 那里是纯函数、可单测，
 * 而且失败时能直接把"实际字段名"报出来，不用靠实测撞。
 * @param client - 页面 CDP 连接。
 * @param chatSessionId - DS 会话 id。
 * @param timeoutMs - 超时毫秒。
 * @returns 归一化后的历史与取样诊断，或结构化失败。
 */
export async function readHistory(
  client: CdpClient,
  chatSessionId: string,
  timeoutMs = 20000,
): Promise<
  | { ok: true; messages: DsHistoryMessage[]; diagnostics: { count: number; keys: string[]; roles: string[]; statuses: string[] } }
  | BrowserFailure
> {
  // 保留最近 40 条、每条正文最多 8000 字符：足够判断"新消息"，又不会把大历史搬过 CDP
  const expression = `(async () => {
    try {
      const token = (() => { try { const v = JSON.parse(localStorage.getItem('userToken') || 'null'); return (v && typeof v.value === 'string') ? v.value : (typeof v === 'string' ? v : '') } catch { return '' } })()
      const res = await fetch('/api/v0/chat/history_messages?chat_session_id=' + encodeURIComponent(${JSON.stringify(chatSessionId)}), {
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      })
      const json = await res.json()
      const biz = json && json.data && json.data.biz_data
      const list = (biz && biz.chat_messages) || []
      const trimmed = list.slice(Math.max(0, list.length - 40)).map((row) => {
        if (!row || typeof row !== 'object') return row
        const copy = Object.assign({}, row)
        if (typeof copy.content === 'string' && copy.content.length > 8000) copy.content = copy.content.slice(0, 8000)
        if (Array.isArray(copy.content)) copy.content = copy.content.slice(0, 40)
        delete copy.thinking_content
        return copy
      })
      return { ok: true, rows: trimmed }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  })()`
  try {
    const value = await evaluate<{ ok: boolean; rows?: unknown; error?: string }>(client, expression, {
      awaitPromise: true,
      timeoutMs,
    })
    if (value === undefined || value.ok !== true) {
      return { ok: false, code: 'DELIVER_FAILED', error: '读取 DS 会话历史失败', detail: value?.error ?? '页面内 fetch 无返回' }
    }
    return {
      ok: true,
      messages: normalizeHistoryRows(value.rows),
      diagnostics: describeHistoryRows(value.rows),
    }
  } catch (error) {
    return {
      ok: false,
      code: 'DELIVER_FAILED',
      error: '读取 DS 会话历史失败',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/** 等待新消息的可选条件。 */
export interface WaitForMessageOptions {
  /** 投递前的已有消息 id 集合（用于识别"新出现的"）。 */
  baselineIds: ReadonlySet<string>
  /** 只接受这个角色的新消息。 */
  role: 'user' | 'assistant'
  /** user 模式：新消息文本应与之匹配（宽松指纹）。 */
  matchText?: string
  /** 超时毫秒。 */
  timeoutMs: number
  /** 外部取消。 */
  signal?: AbortSignal
  /** 轮询间隔毫秒。 */
  intervalMs?: number
}

/**
 * 轮询等待一条新消息出现。
 *
 * 优先等 `FINISHED` 的消息（避免对还在流式生成的助手回复取音频，那种情况下服务端
 * 可能只看到半截正文）；到超时仍没等到完成态时，**退而接受**已经出现的那条，
 * 而不是把一个本来能用的朗读判死。失败详情里带上真实角色/状态/字段名，便于一眼定位改版。
 * @param client - 页面 CDP 连接。
 * @param chatSessionId - DS 会话 id。
 * @param options - 基线 / 角色 / 匹配文本 / 超时 / 取消。
 * @returns 新消息（可能带"未等完成态"的说明）或结构化失败。
 */
export async function waitForNewMessage(
  client: CdpClient,
  chatSessionId: string,
  options: WaitForMessageOptions,
): Promise<{ ok: true; message: DsHistoryMessage; degraded: boolean } | BrowserFailure> {
  const interval = options.intervalMs ?? 1500
  const deadline = Date.now() + options.timeoutMs
  let loose: DsHistoryMessage | undefined
  let lastDetail = '还没有看到新消息'
  let diagnostics: { count: number; keys: string[]; roles: string[]; statuses: string[] } = {
    count: 0,
    keys: [],
    roles: [],
    statuses: [],
  }

  const baseOptions = {
    baselineIds: options.baselineIds,
    role: options.role,
    ...(options.matchText === undefined ? {} : { matchText: options.matchText }),
  }

  while (Date.now() < deadline) {
    if (options.signal?.aborted === true) {
      return { ok: false, code: 'CANCELLED', error: '已取消', detail: '等待新消息时被取消' }
    }
    const history = await readHistory(client, chatSessionId, 20000)
    if (!history.ok) {
      lastDetail = `${history.error} / ${history.detail}`
    } else {
      diagnostics = history.diagnostics
      const finished = pickNewMessage(history.messages, { ...baseOptions, finishedOnly: true })
      if (finished !== undefined) return { ok: true, message: finished, degraded: false }
      const any = pickNewMessage(history.messages, baseOptions)
      if (any !== undefined) loose = any
      lastDetail =
        `等待已完成的新 ${options.role} 消息（历史 ${diagnostics.count.toString()} 条，` +
        `roles=[${diagnostics.roles.join(',')}] statuses=[${diagnostics.statuses.join(',')}] ` +
        `keys=[${diagnostics.keys.slice(0, 10).join(',')}]${loose === undefined ? '' : '，已有未完成候选' }）`
    }
    await new Promise((resolve) => setTimeout(resolve, interval))
  }

  // 超时兜底：已经出现了新消息，只是没等到完成态 —— 接受它，别把功能判死
  if (loose !== undefined) return { ok: true, message: loose, degraded: true }

  return {
    ok: false,
    code: 'MESSAGE_NOT_FOUND',
    error: '投递后没能取到对应的 DS 消息 id',
    detail: `${lastDetail}；诊断：count=${diagnostics.count.toString()} roles=[${diagnostics.roles.join(',')}] statuses=[${diagnostics.statuses.join(',')}] keys=[${diagnostics.keys.slice(0, 12).join(',')}]`,
  }
}

/**
 * 把文本写进页面剪贴板（投递失败时的降级：让用户手动粘一下）。
 * @param client - 页面 CDP 连接。
 * @param text - 待复制文本。
 * @returns 是否成功。
 */
export async function copyToPageClipboard(client: CdpClient, text: string): Promise<boolean> {
  try {
    const value = await evaluate<boolean>(
      client,
      `(async () => { try { await navigator.clipboard.writeText(${JSON.stringify(text)}); return true } catch { return false } })()`,
      { awaitPromise: true, timeoutMs: 8000 },
    )
    return value === true
  } catch {
    return false
  }
}

/**
 * 连到某个页面 target。
 * @param target - `/json/list` 或 `/json/new` 给的目标。
 * @returns CDP 客户端。
 */
export async function attach(target: CdpTarget): Promise<CdpClient> {
  const wsUrl = target.webSocketDebuggerUrl
  if (wsUrl === undefined) throw new Error('target 没有 webSocketDebuggerUrl')
  return await CdpClient.connect(wsUrl)
}
