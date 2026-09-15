/**
 * 极简 CDP（Chrome DevTools Protocol）客户端。
 *
 * 为什么自己写而不上 playwright/puppeteer：本包以 link: 装进 profile，pnpm 不会
 * 为它建 node_modules，多一个重依赖就多一份解析风险；而这里只需要
 * `/json/list` 找到页面 + 一条 WebSocket 上的 JSON-RPC，`ws` 就够。
 *
 * 连接策略：直接用**页面级** target 的 webSocketDebuggerUrl，命令不带 sessionId，
 * 省掉 Target.attachToTarget / flatten 那套会话转发。
 */
import WebSocket from 'ws'

/** 一个调试目标（来自 `/json/list`）。 */
export interface CdpTarget {
  id: string
  type: string
  url: string
  title: string
  webSocketDebuggerUrl?: string
}

/** CDP 事件处理函数。 */
export type CdpEventHandler = (params: unknown) => void

/**
 * 给 promise 加超时（超时时 reject，不取消底层操作）。
 * @param promise - 原 promise。
 * @param ms - 超时毫秒。
 * @param message - 超时错误信息。
 * @returns 原 promise 的结果。
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message))
        }, ms)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * 取某个 CDP HTTP 端点的版本信息。
 * @param base - 形如 `http://127.0.0.1:9222`。
 * @param timeoutMs - 超时毫秒。
 * @returns 版本信息；端点不可达时 undefined。
 */
export async function fetchCdpVersion(
  base: string,
  timeoutMs = 3000,
): Promise<{ browser: string; webSocketDebuggerUrl: string } | undefined> {
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/json/version`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return undefined
    const raw: unknown = await res.json()
    if (typeof raw !== 'object' || raw === null) return undefined
    const row = raw as Record<string, unknown>
    const wsUrl = typeof row.webSocketDebuggerUrl === 'string' ? row.webSocketDebuggerUrl : ''
    if (wsUrl === '') return undefined
    return { browser: typeof row.Browser === 'string' ? row.Browser : '', webSocketDebuggerUrl: wsUrl }
  } catch {
    return undefined
  }
}

/**
 * 列出 CDP 端点上的所有调试目标。
 * @param base - 形如 `http://127.0.0.1:9222`。
 * @param timeoutMs - 超时毫秒。
 * @returns 目标数组；失败时为空数组。
 */
export async function listCdpTargets(base: string, timeoutMs = 5000): Promise<CdpTarget[]> {
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}/json/list`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return []
    const raw: unknown = await res.json()
    if (!Array.isArray(raw)) return []
    return raw
      .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
      .map((row) => ({
        id: typeof row.id === 'string' ? row.id : '',
        type: typeof row.type === 'string' ? row.type : '',
        url: typeof row.url === 'string' ? row.url : '',
        title: typeof row.title === 'string' ? row.title : '',
        webSocketDebuggerUrl: typeof row.webSocketDebuggerUrl === 'string' ? row.webSocketDebuggerUrl : undefined,
      }))
      .filter((target) => target.id !== '' && target.webSocketDebuggerUrl !== undefined)
  } catch {
    return []
  }
}

/**
 * 新开一个标签页（优先 `PUT /json/new`，失败则退回 `Target.createTarget`）。
 * @param base - CDP HTTP 端点。
 * @param url - 要打开的地址。
 * @param timeoutMs - 超时毫秒。
 * @returns 新目标，失败时 undefined。
 */
export async function openCdpTarget(base: string, url: string, timeoutMs = 15000): Promise<CdpTarget | undefined> {
  const root = base.replace(/\/+$/, '')
  // Chrome 111+ 要求 PUT；旧版接受 GET。两种都试。
  for (const method of ['PUT', 'GET'] as const) {
    try {
      const res = await fetch(`${root}/json/new?${encodeURIComponent(url)}`, { method, signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) continue
      const raw: unknown = await res.json()
      if (typeof raw !== 'object' || raw === null) continue
      const row = raw as Record<string, unknown>
      if (typeof row.webSocketDebuggerUrl !== 'string') continue
      return {
        id: typeof row.id === 'string' ? row.id : '',
        type: typeof row.type === 'string' ? row.type : 'page',
        url: typeof row.url === 'string' ? row.url : url,
        title: '',
        webSocketDebuggerUrl: row.webSocketDebuggerUrl,
      }
    } catch {
      // 换下一个方法
    }
  }
  return undefined
}

/**
 * 一条页面级 CDP 连接（JSON-RPC over WebSocket）。
 */
export class CdpClient {
  private readonly ws: WebSocket
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly handlers = new Map<string, Set<CdpEventHandler>>()
  private closedReason = ''

  private constructor(ws: WebSocket) {
    this.ws = ws
    ws.on('message', (data: WebSocket.RawData) => {
      this.onMessage(typeof data === 'string' ? data : data.toString('utf8'))
    })
    ws.on('close', (code: number, reason: Buffer) => {
      this.closedReason = `CDP 连接关闭（code=${code.toString()} ${reason.toString().slice(0, 120)}）`
      this.rejectAll(new Error(this.closedReason))
    })
    ws.on('error', (error: Error) => {
      this.closedReason = `CDP 连接错误：${error.message}`
      this.rejectAll(new Error(this.closedReason))
    })
  }

  /**
   * 连到一个页面级 target。
   * @param wsUrl - target 的 webSocketDebuggerUrl。
   * @param timeoutMs - 握手超时。
   * @returns CDP 客户端。
   */
  static async connect(wsUrl: string, timeoutMs = 10000): Promise<CdpClient> {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          ws.terminate()
        } catch {
          // ignore
        }
        reject(new Error('连接 CDP target 超时'))
      }, timeoutMs)
      ws.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      ws.once('error', (error: Error) => {
        clearTimeout(timer)
        reject(new Error(`连接 CDP target 失败：${error.message}`))
      })
    })
    return new CdpClient(ws)
  }

  /** 连接是否已关闭。 */
  get isClosed(): boolean {
    return this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING
  }

  /** 关闭原因（空串表示没出错）。 */
  get closeReason(): string {
    return this.closedReason
  }

  private rejectAll(error: Error): void {
    for (const [, entry] of this.pending) entry.reject(error)
    this.pending.clear()
  }

  private onMessage(text: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const msg = parsed as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
    if (typeof msg.id === 'number') {
      const entry = this.pending.get(msg.id)
      if (entry === undefined) return
      this.pending.delete(msg.id)
      if (msg.error !== undefined) {
        entry.reject(new Error(msg.error.message ?? 'CDP 命令失败'))
      } else {
        entry.resolve(msg.result)
      }
      return
    }
    if (typeof msg.method === 'string') {
      const set = this.handlers.get(msg.method)
      if (set === undefined) return
      for (const handler of set) {
        try {
          handler(msg.params)
        } catch {
          // 事件处理器的异常不影响协议循环
        }
      }
    }
  }

  /**
   * 发一条 CDP 命令。
   * @param method - CDP 方法名，例如 `Runtime.evaluate`。
   * @param params - 参数对象。
   * @param timeoutMs - 超时毫秒。
   * @returns 命令结果。
   */
  async send<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<T> {
    if (this.isClosed) throw new Error(this.closedReason !== '' ? this.closedReason : 'CDP 连接已关闭')
    const id = this.nextId
    this.nextId += 1
    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.ws.send(JSON.stringify({ id, method, params }))
    return (await withTimeout(result, timeoutMs, `CDP ${method} 超时`)) as T
  }

  /**
   * 订阅一条 CDP 事件。
   * @param event - 事件名，例如 `Page.loadEventFired`。
   * @param handler - 处理函数。
   * @returns 取消订阅函数。
   */
  on(event: string, handler: CdpEventHandler): () => void {
    let set = this.handlers.get(event)
    if (set === undefined) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
    }
  }

  /** 关闭连接。 */
  close(): void {
    try {
      this.ws.close()
    } catch {
      // ignore
    }
  }
}
