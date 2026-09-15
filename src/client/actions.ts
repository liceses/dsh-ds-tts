/**
 * 共享动作：朗读 / 重新生成 / 下载 / 存到工作区 / 停止。
 *
 * 所有入口（消息行按钮、弹窗底部）都走这里，避免重复实现与重复合成。
 *
 * 参数从位置参数改成了**选项对象**：到 `regenerate` 这里已经是第 5 个语义，
 * 再往下加位置参数就会变成"第 5 个参数到底是什么"的可读性债。
 */
import type { DsTtsMode, SynthesizeOk, SynthesizeResult } from '../protocol.ts'
import { cancelSynthesis, exportAudio, synthesize } from './api.ts'
import { downloadAudio, player } from './player.ts'
import { addToast, inputRefs, setState } from './state.ts'

/** 一次合成请求的可选参数。 */
export interface MakeAudioOptions {
  /** 音色覆盖（空串/缺省 = 用配置里的）。 */
  voice?: string | undefined
  /** 投递模式覆盖。 */
  mode?: DsTtsMode | undefined
  /** 归属标记（用于按钮 loading 态）：messageId / 'dialog' / 'download' / 'save'。 */
  owner?: string
  /** 动作种类（决定哪个按钮显示 loading）。 */
  kind?: 'speak' | 'regen'
  /**
   * 强制重新合成（跳过缓存）。
   *
   * DS 官方 TTS 每次合成的声音可能不同，而同文本默认走内容缓存 —— 想再要一版必须显式要求。
   */
  regenerate?: boolean
}

/** 把失败结果变成 toast + 状态。 */
function reportFailure(result: Extract<SynthesizeResult, { ok: false }>): void {
  const extra = result.detail === undefined || result.detail === '' ? '' : `（${result.detail}）`
  addToast(`${result.error}${extra}`, 'error')
  setState({ phase: 'error', progress: '', activeOwner: '', activeKind: '', lastError: result.error })
}

/** 合成期间的进度文案。 */
function progressText(regenerate: boolean): string {
  return regenerate ? '重新生成中…（会合成新的一版）' : '投递中…（首次会慢一些）'
}

/**
 * 合成（不播放）。缓存命中时几乎是瞬时的；`regenerate` 时一定走真合成。
 * @param text - 待朗读文本。
 * @param options - 音色 / 模式 / 归属 / 是否重新生成。
 * @returns 成功结果；失败返回 undefined（已弹 toast）。
 */
export async function makeAudio(text: string, options: MakeAudioOptions = {}): Promise<SynthesizeOk | undefined> {
  const trimmed = text.trim()
  if (trimmed === '') {
    addToast('没有可朗读的正文', 'error')
    return undefined
  }
  const regenerate = options.regenerate === true
  const owner = options.owner ?? 'dialog'
  setState({
    phase: 'submitting',
    activeOwner: owner,
    activeKind: options.kind ?? 'speak',
    progress: progressText(regenerate),
    lastError: '',
  })
  let result: SynthesizeResult
  try {
    result = await synthesize({
      text: trimmed,
      ...(options.voice !== undefined && options.voice !== '' ? { voice: options.voice } : {}),
      ...(options.mode !== undefined ? { mode: options.mode } : {}),
      ...(regenerate ? { regenerate: true } : {}),
      ...(inputRefs.sessionId !== '' ? { sessionId: inputRefs.sessionId } : {}),
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    addToast(`请求 ds-tts 失败：${message}`, 'error')
    setState({ phase: 'error', progress: '', activeOwner: '', activeKind: '', lastError: message })
    return undefined
  }
  if (!result.ok) {
    reportFailure(result)
    return undefined
  }
  if (result.truncated) addToast('内容较长，本次只朗读了前一部分（可在设置里调大上限）')
  if (result.regenerated) addToast('已重新生成一版新音频')
  return result
}

/**
 * 合成并播放（全局单实例，新朗读自动停旧的）。
 * @param text - 待朗读文本。
 * @param owner - 归属标记（messageId 或 'dialog'）。
 * @param options - 音色 / 模式 / 是否重新生成。
 */
export async function speak(text: string, owner: string, options: MakeAudioOptions = {}): Promise<void> {
  const made = await makeAudio(text, { ...options, owner, kind: options.regenerate === true ? 'regen' : 'speak' })
  if (made === undefined) return
  setState({ phase: 'submitting', activeOwner: owner, activeKind: made.regenerated ? 'regen' : 'speak', activeSynthesisId: made.id, progress: '准备播放…' })
  const kind = made.regenerated ? 'regen' : 'speak'
  const started = await player.play(made.url, {
    onEnded: () => {
      setState({ phase: 'idle', activeOwner: '', activeKind: '', activeSynthesisId: '', progress: '' })
    },
    onError: (message) => {
      addToast(message, 'error')
      setState({ phase: 'error', activeOwner: '', activeKind: '', activeSynthesisId: '', progress: '', lastError: message })
    },
  })
  if (started) {
    setState({
      phase: 'playing',
      activeOwner: owner,
      activeKind: kind,
      activeSynthesisId: made.id,
      progress: `播放中 · ${made.voice} · ${made.seconds > 0 ? `${made.seconds.toFixed(1)} 秒` : made.ext}${made.regenerated ? ' · 新生成' : ''}`,
    })
  }
}

/**
 * 合成并触发浏览器下载。
 * @param text - 待朗读文本。
 * @param nameHint - 文件名前缀。
 * @param options - 音色 / 是否重新生成。
 */
export async function downloadText(text: string, nameHint: string, options: MakeAudioOptions = {}): Promise<void> {
  const made = await makeAudio(text, { ...options, owner: 'download', kind: 'speak' })
  if (made === undefined) return
  downloadAudio(made.url, `${nameHint}-${made.id}.${made.ext}`)
  addToast(`已开始下载 ${made.ext.toUpperCase()}（${(made.bytes / 1024).toFixed(1)} KB）`)
  setState({ phase: 'idle', activeOwner: '', activeKind: '', progress: '' })
}

/**
 * 合成并把文件存进当前会话工作区（`.dsh/tts/`）。
 * @param text - 待朗读文本。
 * @param options - 音色 / 是否重新生成。
 */
export async function saveToWorkspace(text: string, options: MakeAudioOptions = {}): Promise<void> {
  if (inputRefs.sessionId === '') {
    addToast('还没有会话上下文，无法定位工作区', 'error')
    return
  }
  const made = await makeAudio(text, { ...options, owner: 'save', kind: 'speak' })
  if (made === undefined) return
  const result = await exportAudio({ id: made.id, ext: made.ext, sessionId: inputRefs.sessionId })
  if (result.ok) {
    addToast(`已存到工作区：${result.path}`)
  } else {
    addToast(`${result.error}${result.detail === undefined ? '' : `（${result.detail}）`}`, 'error')
  }
  setState({ phase: 'idle', activeOwner: '', activeKind: '', progress: '' })
}

/** 停止播放并取消进行中的合成。 */
export function stopAll(): void {
  player.stop()
  void cancelSynthesis().catch(() => undefined)
  setState({ phase: 'idle', activeOwner: '', activeKind: '', activeSynthesisId: '', progress: '', lastError: '' })
}
