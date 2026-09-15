/**
 * 宿主路由的 fetch 封装（浏览器半）。
 *
 * 一律同源相对路径；宿主侧有"仅回环 + 同源"护栏，页面请求天然带 cookie/标记。
 */
import type {
  CancelResult,
  DsTtsConfigPatch,
  DsTtsConfigView,
  ExportRequest,
  ExportResult,
  SetVoiceResult,
  StatusResult,
  SynthesizeRequest,
  SynthesizeResult,
  VoicesResult,
} from '../protocol.ts'
import { CANCEL_PATH, CONFIG_PATH, EXPORT_PATH, STATUS_PATH, SYNTHESIZE_PATH, VOICES_PATH, VOICE_PATH } from '../routes-shared.ts'

/** 统一 POST/GET JSON。 */
async function jsonFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`ds-tts 路由返回了非 JSON 响应（HTTP ${response.status.toString()}）`)
  }
}

/**
 * 文本 → 音频。
 * @param body - 合成请求。
 * @returns 合成结果。
 */
export async function synthesize(body: SynthesizeRequest): Promise<SynthesizeResult> {
  return await jsonFetch<SynthesizeResult>(SYNTHESIZE_PATH, { method: 'POST', body: JSON.stringify(body) })
}

/**
 * 把缓存音频导出到会话工作区。
 * @param body - 导出请求。
 * @returns 导出结果。
 */
export async function exportAudio(body: ExportRequest): Promise<ExportResult> {
  return await jsonFetch<ExportResult>(EXPORT_PATH, { method: 'POST', body: JSON.stringify(body) })
}

/**
 * 取 DS 官方音色列表。
 * @param force - 强制刷新。
 * @returns 音色结果。
 */
export async function fetchVoices(force = false): Promise<VoicesResult> {
  return await jsonFetch<VoicesResult>(`${VOICES_PATH}${force ? '?force=1' : ''}`)
}

/**
 * 切换 DS 账号朗读音色。
 * @param voiceId - 目标音色。
 * @returns 切换结果。
 */
export async function setVoice(voiceId: string): Promise<SetVoiceResult> {
  return await jsonFetch<SetVoiceResult>(VOICE_PATH, { method: 'POST', body: JSON.stringify({ voiceId }) })
}

/**
 * 状态自查。
 * @param probe - 是否顺带做一次真实探测（会打开浏览器）。
 * @returns 状态结果。
 */
export async function fetchStatus(probe = false): Promise<StatusResult> {
  return await jsonFetch<StatusResult>(`${STATUS_PATH}${probe ? '?probe=1' : ''}`)
}

/**
 * 读生效配置。
 * @returns 配置。
 */
export async function fetchConfig(): Promise<{ ok: boolean; config: DsTtsConfigView }> {
  return await jsonFetch<{ ok: boolean; config: DsTtsConfigView }>(CONFIG_PATH)
}

/**
 * 写配置补丁。
 * @param patch - 部分配置。
 * @returns 写入结果。
 */
export async function patchConfig(patch: DsTtsConfigPatch): Promise<{ ok: boolean; config?: DsTtsConfigView; error?: string }> {
  return await jsonFetch<{ ok: boolean; config?: DsTtsConfigView; error?: string }>(CONFIG_PATH, {
    method: 'PUT',
    body: JSON.stringify(patch),
  })
}

/**
 * 取消排队/进行中的合成。
 * @param id - 指定合成 id；缺省取消全部。
 * @returns 取消结果。
 */
export async function cancelSynthesis(id?: string): Promise<CancelResult> {
  return await jsonFetch<CancelResult>(CANCEL_PATH, { method: 'POST', body: JSON.stringify(id === undefined ? {} : { id }) })
}
