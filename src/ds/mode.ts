/**
 * 投递模式决策（纯函数，可单测）。
 *
 * ## 实测事实（2026-09-14，真实账号 + 真实会话）
 *
 * 对同一条会话里的两条消息分别合成：
 *
 * | 目标 | 结果 |
 * |---|---|
 * | `message_id=2`（**ASSISTANT**） | `code 0 / success`，627 帧 / 3,009,162 字节 / pcm / 62.69 秒 ✅ |
 * | `message_id=1`（**USER**） | `code 6 / no_content`，0 帧 / 0 字节 ❌ |
 *
 * 结论：**DS 官方 TTS 只接受助手消息**。请求里只有
 * `chat_session_id + message_id`、正文由服务端取，所以"读任意文本 / 读 DSH 消息"
 * 只能先把文本变成 DS 会话里的一条**助手回复** —— 也就是 echo 模式：
 *
 *   echo = 投递一条「请原样输出以下文本…」的用户消息 → DS 模型写回助手回复 → 朗读它
 *
 * 这个代价是"必须用 DS 官方音色"的固有成本：文本要先在 DS 那边被复述一遍。
 *
 * ## 因此默认值是 echo
 *
 * 默认 `auto` 会先试一次 user：白跑一轮（投递 + 等消息 + 取票 + wss 拿到 6），
 * 而且那条用户消息会**永久留在你的 DS 会话里**。既然已经实测过，就不该让每个
 * 新用户都默认踩这一下。`auto` 保留为"将来 DS 若支持用户消息时用于自我发现"。
 */
import type { DsTtsMode, DsTtsResolvedMode } from '../protocol.ts'

/**
 * 决定尝试顺序。
 * @param requested - 用户配置的模式。
 * @param userModeSupported - 运行时已知的 user 模式可用性（null = 未验证）。
 * @returns 按序尝试的模式列表（1 或 2 项）。
 */
export function resolveAttemptOrder(
  requested: DsTtsMode,
  userModeSupported: boolean | null,
): readonly DsTtsResolvedMode[] {
  if (requested === 'user') {
    // 显式要求：只试 user，失败就报错（用于将来验证 DS 是否已支持）
    return ['user']
  }
  if (requested === 'auto') {
    // 自我发现：已知不可用就别再试；未验证/已知可用才先试 user
    return userModeSupported === false ? ['echo'] : ['user', 'echo']
  }
  return ['echo']
}
