/**
 * ds-tts — 浏览器半（在 dsh Web GUI 里运行）。
 *
 * 注册五个 seat：
 *   conversation.chat.assistant-actions ×2  🔊 朗读 / ⤓ 导出（两个独立 cell）
 *   conversation.input.left                 「朗读文字」按钮（打开任意文本弹窗）
 *   shell.overlay                           迷你播放条 + 弹窗 + toast 栈
 *   settings.general.item                   音色/格式/模式/浏览器/状态自查
 *
 * 所有 seat 都用 `slots.inject(name, cb)` 等声明就绪后再注册 —— assistant-actions
 * 是由 conversation.chat.node 的一个条目在挂载时声明的，早注册会抛。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// 这两个 import 只为把官方 SlotMap 增补（assistant-actions / conversation.input.left
// 以及 sessionId、useChat 等标准座位）带进本插件的类型程序；运行时不 import。
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { clearToastTimers } from './state.ts'
import { CSS, ComposerAskButton, DownloadAction, Overlay, RegenerateAction, SettingsRow, SpeakAction } from './ui.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** 框架级浮层（client-ui-layout 在 root 条目里声明）。 */
    'shell.overlay': { kind: 'list'; scope: 'root'; owner: Record<string, never> }
    /** 设置 → 通用的单行偏好（ui-settings-general 声明，owner 不传 props）。 */
    'settings.general.item': { kind: 'list'; scope: 'root'; owner: Record<string, never> }
  }
}

/** 必需服务：座位注册表。 */
export const inject = ['slots']

/**
 * 挂载浏览器半。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  // 包样式（每页注入一次）
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset.plugin = 'ds-tts'
    style.textContent = CSS
    document.head.appendChild(style)
    return () => {
      style.remove()
    }
  }, 'ds-tts: styles')

  // toast 定时器随 fiber 卸载清理
  ctx.effect(() => clearToastTimers, 'ds-tts: toast timers')

  // 助手消息动作行：朗读 + 导出 + 重新生成（三个独立 cell，互不覆盖）
  ctx.slots.inject('conversation.chat.assistant-actions', () =>
    ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'ds-tts-speak', order: 50 }, SpeakAction),
  )
  ctx.slots.inject('conversation.chat.assistant-actions', () =>
    ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'ds-tts-download', order: 51 }, DownloadAction),
  )
  // 重新生成：DS 每次合成的声音可能不同，缓存会让同文本秒回同一版，所以需要显式再要一版
  ctx.slots.inject('conversation.chat.assistant-actions', () =>
    ctx.slots.register({ name: 'conversation.chat.assistant-actions', id: 'ds-tts-regen', order: 52 }, RegenerateAction),
  )

  // 输入框工具排：朗读任意文字
  ctx.slots.inject('conversation.input.left', () =>
    ctx.slots.register({ name: 'conversation.input.left', id: 'ds-tts-ask', order: 92 }, ComposerAskButton),
  )

  // 浮层：播放条 + 弹窗 + toast
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'ds-tts-overlay', order: 92 }, Overlay))

  // 设置行
  ctx.slots.inject('settings.general.item', () =>
    ctx.slots.register({ name: 'settings.general.item', id: 'ds-tts-settings', order: 92 }, SettingsRow),
  )
}
