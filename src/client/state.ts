/**
 * 浏览器半的模块级状态（配合 useSyncExternalStore）。
 *
 * 只放"跨组件共享"的东西：播放阶段、弹窗、toast、配置与音色缓存、
 * 以及从 slot 座位镜像下来的当前会话 id（导出到工作区时要用）。
 */
import type { DsTtsConfigView, DsTtsVoice, StatusResult } from '../protocol.ts'

/** 播放阶段。 */
export type SpeakPhase = 'idle' | 'submitting' | 'playing' | 'error'

/** 一条 toast。 */
export interface Toast {
  id: number
  text: string
  level: 'info' | 'error'
}

/** 共享状态。 */
export interface ClientState {
  /** 当前阶段。 */
  phase: SpeakPhase
  /** 触发当前朗读的归属：messageId 或 'dialog'。 */
  activeOwner: string
  /** 正在播放/加载的合成 id。 */
  activeSynthesisId: string
  /**
   * 当前活跃的是哪个动作：'speak'（朗读/播放）还是 'regen'（重新生成）。
   *
   * 为什么需要：消息行上朗读与重新生成是两个相邻按钮、共用 activeOwner；
   * 没有这个区分的话，点 ⟳ 时 🔊 也会一起显示 loading。
   */
  activeKind: 'speak' | 'regen' | ''
  /** 进度文案。 */
  progress: string
  /** 最近一次错误。 */
  lastError: string
  /** toast 栈。 */
  toasts: Toast[]
  /** 弹窗开关。 */
  dialogOpen: boolean
  /** 弹窗里的文本。 */
  dialogText: string
  /** 弹窗里选中的音色（空串=用配置里的）。 */
  dialogVoice: string
  /** 弹窗里选中的投递模式（空串=用配置里的）。 */
  dialogMode: string
  /** 生效配置（首次拉取后填充）。 */
  config: DsTtsConfigView | null
  /** 服务端音色列表。 */
  voices: DsTtsVoice[]
  /** 账号当前音色。 */
  currentVoiceId: string
  /** 状态自查结果。 */
  status: StatusResult | null
  /** 试听用的公开 CDN 地址。 */
  demoUrl: string
}

let state: ClientState = {
  phase: 'idle',
  activeOwner: '',
  activeKind: '',
  activeSynthesisId: '',
  progress: '',
  lastError: '',
  toasts: [],
  dialogOpen: false,
  dialogText: '',
  dialogVoice: '',
  dialogMode: '',
  config: null,
  voices: [],
  currentVoiceId: '',
  status: null,
  demoUrl: '',
}

const listeners = new Set<() => void>()
let toastSeq = 0
const toastTimers = new Set<number>()

/**
 * 订阅状态变化。
 * @param listener - 变化回调。
 * @returns 取消订阅。
 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * 读当前快照（引用稳定，直到下次 setState）。
 * @returns 状态快照。
 */
export function getSnapshot(): ClientState {
  return state
}

/** 通知所有订阅者。 */
function emit(): void {
  for (const listener of listeners) listener()
}

/**
 * 合并状态。
 * @param patch - 部分状态。
 */
export function setState(patch: Partial<ClientState>): void {
  state = { ...state, ...patch }
  emit()
}

/**
 * 弹一条 toast（自动消失）。
 * @param text - 文案。
 * @param level - 级别。
 */
export function addToast(text: string, level: 'info' | 'error' = 'info'): void {
  toastSeq += 1
  const toast: Toast = { id: toastSeq, text, level }
  setState({ toasts: [...state.toasts, toast] })
  const timer = window.setTimeout(() => {
    toastTimers.delete(timer)
    setState({ toasts: state.toasts.filter((item) => item.id !== toast.id) })
  }, level === 'error' ? 9000 : 5000)
  toastTimers.add(timer)
}

/** 清理所有 toast 定时器（fiber 卸载时调用）。 */
export function clearToastTimers(): void {
  for (const timer of toastTimers) window.clearTimeout(timer)
  toastTimers.clear()
}

/** 从 slot 座位镜像下来的运行时引用。 */
export const inputRefs: { sessionId: string } = { sessionId: '' }

/**
 * 把音频 URL 转成绝对地址（`<audio>` 与下载都用同源相对路径即可，这里用于展示）。
 * @param url - 相对 URL。
 * @returns 绝对 URL。
 */
export function absoluteUrl(url: string): string {
  try {
    return new URL(url, window.location.href).href
  } catch {
    return url
  }
}
