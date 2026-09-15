/**
 * 路由路径常量（宿主半与浏览器半共享，避免两边写死字符串写歪）。
 */

/** 所有 ds-tts 路由的公共前缀。 */
export const API_PREFIX = '/api/ds-tts'

/** POST：文本进、音频出。 */
export const SYNTHESIZE_PATH = `${API_PREFIX}/synthesize`

/** GET：`${AUDIO_PATH}/<id>.<ext>` 取音频字节。 */
export const AUDIO_PATH = `${API_PREFIX}/audio`

/** POST：把缓存里的音频导出到会话工作区。 */
export const EXPORT_PATH = `${API_PREFIX}/export`

/** GET：DS 官方音色列表（含公开 CDN 试听地址）。 */
export const VOICES_PATH = `${API_PREFIX}/voices`

/** POST：切换 DS 账号级朗读音色。 */
export const VOICE_PATH = `${API_PREFIX}/voice`

/** GET：浏览器 / 登录 / 放行 / 队列 / 缓存 自查。 */
export const STATUS_PATH = `${API_PREFIX}/status`

/** GET / PUT：生效配置读写。 */
export const CONFIG_PATH = `${API_PREFIX}/config`

/** POST：取消排队或进行中的合成。 */
export const CANCEL_PATH = `${API_PREFIX}/cancel`

/**
 * 拼一个音频 URL。
 * @param id - 内容寻址 id（16 位小写 hex）。
 * @param ext - 文件扩展名（wav / mp3 / opus）。
 * @returns 同源音频路径。
 */
export function audioUrl(id: string, ext: string): string {
  return `${AUDIO_PATH}/${id}.${ext}`
}
