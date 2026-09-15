/**
 * 从 Chat 快照里反查某条助手消息的纯文本。
 *
 * slot `conversation.chat.assistant-actions` 只给 `messageId`，正文得自己取：
 * 标准座位提供的 `useChat` 选择器能读到 ChatSnapshot，其 `legacy.nodes` 是
 * 身份稳定的节点数组（适合 useSyncExternalStore 风格的选择器）。
 */
import type { ChatSnapshot, UseChat } from '@deepseek-ai/dsh-client-ui-chat/client'

/** 一条助手消息的可见文本（只取 text 块，跳过思维链与工具调用）。 */
export function assistantTextOf(snapshot: ChatSnapshot, messageId: string): string {
  for (const node of snapshot.legacy.nodes) {
    if (node.kind !== 'assistant') continue
    if (node.messageId === undefined || String(node.messageId) !== messageId) continue
    const parts: string[] = []
    for (const block of node.blocks) {
      if (block.kind === 'text') parts.push(block.text)
    }
    return parts.join('\n\n')
  }
  return ''
}

/**
 * 订阅式读取某条助手消息的文本。
 * @param useChat - 标准座位提供的 Chat 选择器 hook。
 * @param messageId - 目标消息 id。
 * @returns 文本（找不到时为空串）。
 */
export function useAssistantText(useChat: UseChat, messageId: string): string {
  return useChat((snapshot: ChatSnapshot) => assistantTextOf(snapshot, messageId))
}
