/**
 * 浏览器半的 UI：
 *   - SpeakAction / DownloadAction：助手消息动作行里的 朗读 / 下载（两个独立 cell，互不覆盖）
 *   - ComposerAskButton：输入框左侧的朗读入口（**纯图标**，内建 待命/合成中/朗读中 三态）
 *   - Overlay：迷你播放条 + 任意文本弹窗（**双栏**）+ toast 栈（shell.overlay，root 作用域）
 *   - SettingsRow：设置 → 通用 里的音色/格式/模式/浏览器/自查行
 *
 * 视觉约定（对照官方产物核过）：
 *   - 强调色一律用官方单色 brand，不用自造彩色（旧的 #4c9aff 已删）
 *   - 图标用官方 primitives（16px 描边体系），见 icons.tsx
 *   - 动作层级：主行动唯一实底，其余 ghost / quiet
 */
import { useEffect, useState, useSyncExternalStore, type ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { KNOWN_DS_VOICES, type DsTtsFormat, type DsTtsMode, type DsTtsVoice } from '../protocol.ts'
import { downloadText, saveToWorkspace, speak, stopAll } from './actions.ts'
import { fetchConfig, fetchStatus, fetchVoices, patchConfig, setVoice } from './api.ts'
import { IconClose, IconDownload, IconLoading, IconRefresh, IconStop, PlayingBars, SaveGlyph, SpeakerGlyph } from './icons.tsx'
import { player } from './player.ts'
import { addToast, getSnapshot, inputRefs, setState, subscribe } from './state.ts'
import { useAssistantText } from './transcript.ts'

/** 助手消息动作行的座位 props（含 messageId 与标准座位 useChat/sessionId）。 */
export type AssistantActionProps = PropsRuntime<'conversation.chat.assistant-actions'>
/** 输入框工具排座位的 props。 */
export type ComposerProps = PropsRuntime<'conversation.input.left'>

/**
 * 朗读一条助手消息。
 * @param props - 座位 props。
 * @returns 按钮元素。
 */
export function SpeakAction(props: AssistantActionProps): ReactElement {
  const text = useAssistantText(props.useChat, String(props.messageId))
  const state = useSyncExternalStore(subscribe, getSnapshot)
  const mine = state.activeOwner === String(props.messageId)
  const busy = mine && state.activeKind === 'speak' && state.phase === 'submitting'
  const playing = mine && state.activeKind === 'speak' && state.phase === 'playing'
  // 同一时刻只允许一个动作在该消息上跑：重新生成进行中时朗读按钮禁用（反之亦然）
  const otherBusy = mine && state.activeKind === 'regen' && state.phase === 'submitting'
  const disabled = text.trim() === '' || otherBusy

  const onClick = (): void => {
    if (busy || playing) {
      stopAll()
      return
    }
    inputRefs.sessionId = props.sessionId === undefined ? inputRefs.sessionId : String(props.sessionId)
    void speak(text, String(props.messageId), {})
  }

  return (
    <button
      type="button"
      className={`ds-tts-icon-btn${playing ? ' ds-tts-icon-btn--on' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={disabled ? '这条消息没有可朗读的正文' : playing ? '停止朗读' : busy ? '正在合成…（点击取消）' : '用 DeepSeek 官方音色朗读'}
      aria-label={playing ? '停止朗读' : '朗读'}
      aria-pressed={playing}
    >
      {busy ? <span className="ds-tts-spin"><IconLoading /></span> : playing ? <PlayingBars /> : <SpeakerGlyph />}
    </button>
  )
}

/**
 * 重新生成一条消息的音频。
 *
 * 存在的理由：DS 官方 TTS **每次合成的声音可能不同**，而同一文本默认走内容缓存
 * （第二次秒回同一版）。想再要一版就必须显式要求重新生成 —— 新的一版会覆盖旧那一版，
 * 并带上新的 URL 版本令牌，所以浏览器一定会取到新字节。
 * @param props - 座位 props。
 * @returns 按钮元素。
 */
export function RegenerateAction(props: AssistantActionProps): ReactElement {
  const text = useAssistantText(props.useChat, String(props.messageId))
  const state = useSyncExternalStore(subscribe, getSnapshot)
  const mine = state.activeOwner === String(props.messageId)
  const busy = mine && state.activeKind === 'regen' && state.phase === 'submitting'
  const otherBusy = mine && state.activeKind === 'speak' && state.phase === 'submitting'
  const disabled = text.trim() === '' || otherBusy

  return (
    <button
      type="button"
      className="ds-tts-icon-btn"
      disabled={disabled}
      title={disabled ? '这条消息没有可朗读的正文' : '重新生成一版新音频（DS 每次合成的声音可能不同）'}
      aria-label="重新生成"
      onClick={() => {
        inputRefs.sessionId = props.sessionId === undefined ? inputRefs.sessionId : String(props.sessionId)
        void speak(text, String(props.messageId), { regenerate: true })
      }}
    >
      {busy ? <span className="ds-tts-spin"><IconLoading /></span> : <IconRefresh />}
    </button>
  )
}

/**
 * 导出（下载 / 存到工作区）。下载用官方 `IconDownloadOutline16`。
 * @param props - 座位 props。
 * @returns 两个图标按钮。
 */
export function DownloadAction(props: AssistantActionProps): ReactElement {
  const text = useAssistantText(props.useChat, String(props.messageId))
  const disabled = text.trim() === ''
  const mirror = (): void => {
    inputRefs.sessionId = props.sessionId === undefined ? inputRefs.sessionId : String(props.sessionId)
  }
  return (
    <span className="ds-tts-icon-pair">
      <button
        type="button"
        className="ds-tts-icon-btn"
        disabled={disabled}
        title={disabled ? '这条消息没有可导出的正文' : '导出音频并下载'}
        aria-label="导出音频"
        onClick={() => {
          mirror()
          void downloadText(text, 'ds-tts', {})
        }}
      >
        <IconDownload />
      </button>
      <button
        type="button"
        className="ds-tts-icon-btn"
        disabled={disabled}
        title={disabled ? '这条消息没有可导出的正文' : '导出到当前会话工作区 .dsh/tts/'}
        aria-label="存到工作区"
        onClick={() => {
          mirror()
          void saveToWorkspace(text, {})
        }}
      >
        <SaveGlyph />
      </button>
    </span>
  )
}

/**
 * 输入框左侧的朗读入口：**纯图标**，并把 待命 / 合成中 / 朗读中 三态内建在这一个位置。
 *
 * 依据评审回执：q1 同意（不要文字）、btn-c 要改（直接用官方素材做状态）、q5 不同意（不要进度条）。
 * @param props - 座位 props。
 * @returns 按钮元素。
 */
export function ComposerAskButton(props: ComposerProps): ReactElement {
  // 座位每次渲染都把当前会话 id 镜像下来（导出到工作区要用）
  if (props.sessionId !== undefined) inputRefs.sessionId = String(props.sessionId)
  const state = useSyncExternalStore(subscribe, getSnapshot)
  const busy = state.phase === 'submitting'
  const playing = state.phase === 'playing'

  const onClick = (): void => {
    if (busy || playing) {
      stopAll()
      return
    }
    setState({ dialogOpen: true })
  }

  const title = busy ? '正在合成…（点击取消）' : playing ? '正在朗读（点击停止）' : '朗读任意文字（DeepSeek 官方音色）'

  return (
    <button
      type="button"
      className={`ds-tts-icon-btn${playing ? ' ds-tts-icon-btn--on' : ''}`}
      title={title}
      aria-label={title}
      aria-pressed={playing}
      onClick={onClick}
    >
      {busy ? <span className="ds-tts-spin"><IconLoading /></span> : playing ? <PlayingBars /> : <SpeakerGlyph />}
    </button>
  )
}

/** 弹窗里可选音色的来源：服务端列表优先，否则用内置的四个官方音色。 */
function voiceOptions(voices: readonly DsTtsVoice[]): readonly { id: string; label: string }[] {
  if (voices.length > 0) {
    return voices.map((voice) => ({ id: voice.id, label: `${voice.name}（${voice.id}）${voice.description === '' ? '' : ` · ${voice.description}`}` }))
  }
  return KNOWN_DS_VOICES.map((voice) => ({ id: voice.id, label: `${voice.name}（${voice.id}）· ${voice.description}` }))
}

/** 迷你播放条 + 文本弹窗 + toast 栈（shell.overlay）。 */
export function Overlay(): ReactElement {
  const state = useSyncExternalStore(subscribe, getSnapshot)
  const [voices, setVoices] = useState<DsTtsVoice[]>([])
  const [busy, setBusy] = useState(false)

  // 打开弹窗时才去拉音色（避免无谓地唤醒浏览器）
  useEffect(() => {
    if (!state.dialogOpen || voices.length > 0) return
    let cancelled = false
    void fetchVoices().then((result) => {
      if (cancelled) return
      if (result.ok) setVoices(result.voices)
    })
    return () => {
      cancelled = true
    }
  }, [state.dialogOpen, voices.length])

  const showBar = state.phase === 'submitting' || state.phase === 'playing'

  // ── 弹窗派生值（双栏右栏与底部状态行要用） ──
  const charCount = state.dialogText.trim().length
  const maxChars = state.config?.maxChars ?? 2000
  const selectedVoiceId = state.dialogVoice !== '' ? state.dialogVoice : (state.config?.voice ?? 'mira')
  // 时长估算：按实测的 14 字 → 2.59 秒（≈5.4 字/秒）推
  const estimateSeconds = charCount === 0 ? 0 : Math.max(1, Math.round(charCount / 5.4))
  const voiceArg = state.dialogVoice === '' ? undefined : state.dialogVoice
  const modeArg = state.dialogMode === 'user' || state.dialogMode === 'echo' || state.dialogMode === 'auto' ? state.dialogMode : undefined
  const demoUrl = (() => {
    const fromServer = voices.find((voice) => voice.id === selectedVoiceId)
    const urls = fromServer?.demoUrls
    if (urls !== undefined) {
      const picked = urls.zh ?? Object.values(urls)[0]
      if (picked !== undefined && picked !== '') return picked
    }
    return ''
  })()

  return (
    <div className="ds-tts-layer">
      {showBar ? (
        <div className="ds-tts-bar" role="status" aria-live="polite">
          <span className={`ds-tts-bar-icon${state.phase === 'submitting' ? ' ds-tts-bar-icon--spin' : ''}`}>
            {state.phase === 'submitting' ? <IconLoading /> : <IconStop />}
          </span>
          <span className="ds-tts-bar-text">{state.progress === '' ? '处理中…' : state.progress}</span>
          <button type="button" className="ds-tts-bar-stop" onClick={stopAll} aria-label="停止" title="停止">
            <IconStop />
            <span>停止</span>
          </button>
        </div>
      ) : null}

      {state.dialogOpen ? (
        <div className="ds-tts-modal-backdrop" onClick={() => setState({ dialogOpen: false })}>
          <div
            className="ds-tts-modal"
            role="dialog"
            aria-modal="true"
            aria-label="朗读文字"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="ds-tts-modal-head">
              <span className="ds-tts-modal-glyph">
                <SpeakerGlyph />
              </span>
              <span className="ds-tts-modal-title">朗读文字</span>
              <button
                type="button"
                className="ds-tts-icon-btn"
                onClick={() => setState({ dialogOpen: false })}
                aria-label="关闭"
                title="关闭"
              >
                <IconClose />
              </button>
            </div>

            <div className="ds-tts-modal-body">
              <div className="ds-tts-modal-main">
                <textarea
                  className="ds-tts-textarea"
                  placeholder="在这里输入或粘贴要朗读的文字…"
                  value={state.dialogText}
                  onChange={(event) => setState({ dialogText: event.target.value })}
                  rows={7}
                />
                <div className="ds-tts-modal-meta">
                  <span>{charCount} 字</span>
                  <span>上限 {maxChars}</span>
                </div>
              </div>

              <aside className="ds-tts-modal-side">
                <label className="ds-tts-field">
                  <span>音色</span>
                  <select
                    className="ds-tts-select"
                    value={state.dialogVoice}
                    onChange={(event) => setState({ dialogVoice: event.target.value })}
                  >
                    <option value="">跟随设置（{state.config?.voice ?? 'mira'}）</option>
                    {voiceOptions(voices).map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ds-tts-field">
                  <span>投递模式</span>
                  <select
                    className="ds-tts-select"
                    value={state.dialogMode}
                    onChange={(event) => setState({ dialogMode: event.target.value })}
                  >
                    <option value="echo">echo（默认）</option>
                    <option value="auto">auto</option>
                    <option value="user">user</option>
                  </select>
                </label>
                <div className="ds-tts-hint">预计约 {estimateSeconds} 秒 · 需要专用浏览器在运行</div>
                <button
                  type="button"
                  className="ds-tts-btn"
                  disabled={demoUrl === ''}
                  title={demoUrl === '' ? '这个音色没有公开试听地址' : '播放官方 CDN 的音色试听'}
                  onClick={() => {
                    if (demoUrl === '') return
                    void player.playUrl(demoUrl, { onError: (message) => addToast(message, 'error') })
                  }}
                >
                  试听音色
                </button>
              </aside>
            </div>

            <div className="ds-tts-modal-foot">
              <button
                type="button"
                className="ds-tts-btn ds-tts-btn--quiet"
                disabled={busy || charCount === 0}
                onClick={() => {
                  void saveToWorkspace(state.dialogText, { voice: voiceArg })
                }}
              >
                存到工作区
              </button>
              <span className="ds-tts-spacer" />
              <button
                type="button"
                className="ds-tts-btn"
                disabled={busy || charCount === 0}
                title="再合成一版新音频（DS 每次合成的声音可能不同）"
                onClick={() => {
                  void speak(state.dialogText, 'dialog', { voice: voiceArg, mode: modeArg, regenerate: true })
                }}
              >
                重新生成
              </button>
              <button
                type="button"
                className="ds-tts-btn"
                disabled={busy || charCount === 0}
                onClick={() => {
                  void downloadText(state.dialogText, 'ds-tts', { voice: voiceArg })
                }}
              >
                下载
              </button>
              <button
                type="button"
                className="ds-tts-btn ds-tts-btn--primary"
                disabled={busy || charCount === 0}
                onClick={() => {
                  void speak(state.dialogText, 'dialog', { voice: voiceArg, mode: modeArg })
                }}
              >
                朗读
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {state.toasts.length > 0 ? (
        <div className="ds-tts-toasts">
          {state.toasts.map((toast) => (
            <div key={toast.id} className={`ds-tts-toast${toast.level === 'error' ? ' ds-tts-toast--error' : ''}`}>
              {toast.text}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 设置 → 通用 → 语音朗读（ds-tts）。 */
export function SettingsRow(): ReactElement {
  const state = useSyncExternalStore(subscribe, getSnapshot)
  const [voices, setVoices] = useState<DsTtsVoice[]>([])
  const [draftPath, setDraftPath] = useState('')
  const [busy, setBusy] = useState('')
  const [statusText, setStatusText] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const config = await fetchConfig()
      if (!cancelled && config.ok) {
        setState({ config: config.config })
        setDraftPath(config.config.browserPath)
      }
      const list = await fetchVoices()
      if (!cancelled && list.ok) {
        setVoices(list.voices)
        setState({ voices: list.voices, currentVoiceId: list.currentVoiceId ?? '' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const config = state.config
  const update = async (patch: Parameters<typeof patchConfig>[0]): Promise<void> => {
    const result = await patchConfig(patch)
    if (result.ok && result.config !== undefined) {
      setState({ config: result.config })
      return
    }
    addToast(result.error ?? '配置写入失败', 'error')
  }

  if (config === null) {
    return <div className="ds-tts-settings">语音朗读（ds-tts）：正在读取配置…</div>
  }

  const demoUrl = (() => {
    const id = config.voice
    const voice = voices.find((item) => item.id === id) ?? KNOWN_DS_VOICES.find((item) => item.id === id)
    if (voice === undefined || !('demoUrls' in voice)) return ''
    const urls = (voice as DsTtsVoice).demoUrls
    return urls.zh ?? Object.values(urls)[0] ?? ''
  })()

  const status = state.status
  // 三态区分：浏览器没连通 / 连通但没打开 DS 页面 / 打开但没登录 / 已登录。
  // 早期把"没打开页面"和"没登录"都报成未登录，导致登录完还显示要登录。
  const dsStateText = (() => {
    if (status === null) return '未检测'
    if (!status.browser.connected) return '浏览器未连通'
    if (!status.ds.pageFound) return '未打开 DS 页面'
    return status.ds.loggedIn ? '已登录 DS' : '已打开页面但未登录'
  })()

  return (
    <div className="ds-tts-settings">
      <div className="ds-tts-settings-head">
        <span>语音朗读（ds-tts · DeepSeek 官方音色）</span>
        <span className="ds-tts-hint">
          {dsStateText} · {status?.browser.connected === true ? '浏览器已连通' : '浏览器未连通'}
        </span>
      </div>

      <div className="ds-tts-modal-row">
        <label className="ds-tts-label">
          音色
          <select
            className="ds-tts-select"
            value={config.voice}
            onChange={(event) => {
              const voiceId = event.target.value
              void update({ voice: voiceId })
            }}
          >
            {voiceOptions(voices).map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="ds-tts-btn"
          disabled={demoUrl === ''}
          onClick={() => {
            if (demoUrl === '') return
            void player.playUrl(demoUrl, { onError: (message) => addToast(message, 'error') })
          }}
        >
          试听
        </button>
        <button
          type="button"
          className="ds-tts-btn"
          disabled={busy !== ''}
          onClick={() => {
            setBusy('voice')
            void setVoice(config.voice)
              .then((result) => {
                addToast(result.ok ? `${config.voice} 已设为 DS 账号音色` : result.error, result.ok ? 'info' : 'error')
              })
              .finally(() => setBusy(''))
          }}
          title="官方接口是账号级设置：这会把 DS 账号里的「朗读音色」也改成同一个"
        >
          同步到 DS 账号
        </button>
      </div>

      <div className="ds-tts-modal-row">
        <label className="ds-tts-label">
          格式
          <select className="ds-tts-select" value={config.format} onChange={(event) => void update({ format: event.target.value as DsTtsFormat })}>
            <option value="pcm">WAV（无损，推荐）</option>
            <option value="opus">Opus（体积小）</option>
          </select>
        </label>
        <label className="ds-tts-label">
          投递模式
          <select className="ds-tts-select" value={config.mode} onChange={(event) => void update({ mode: event.target.value as DsTtsMode })}>
            <option value="auto">auto（先试 user，失败降级 echo）</option>
            <option value="user">user（读你自己的话）</option>
            <option value="echo">echo（读模型回显）</option>
          </select>
        </label>
        <label className="ds-tts-label">
          上限
          <input
            className="ds-tts-input ds-tts-input--num"
            type="number"
            min={50}
            max={20000}
            value={config.maxChars}
            onChange={(event) => void update({ maxChars: Number(event.target.value) })}
          />
        </label>
      </div>

      <div className="ds-tts-modal-row">
        <label className="ds-tts-check">
          <input type="checkbox" checked={config.echoVerify} onChange={(event) => void update({ echoVerify: event.target.checked })} />
          校验回显（echo 模式下比对模型是否原样复述）
        </label>
        <label className="ds-tts-check">
          <input type="checkbox" checked={config.cacheEnabled} onChange={(event) => void update({ cacheEnabled: event.target.checked })} />
          启用缓存（同文本秒回）
        </label>
      </div>

      <div className="ds-tts-modal-row">
        <label className="ds-tts-label ds-tts-label--grow">
          浏览器路径
          <input
            className="ds-tts-input"
            value={draftPath}
            placeholder="留空自动探测 Edge / Chrome"
            onChange={(event) => setDraftPath(event.target.value)}
            onBlur={() => {
              if (draftPath !== config.browserPath) void update({ browserPath: draftPath })
            }}
          />
        </label>
      </div>

      <div className="ds-tts-modal-row">
        <button
          type="button"
          className="ds-tts-btn"
          disabled={busy !== ''}
          onClick={() => {
            setBusy('probe')
            void fetchStatus(true)
              .then((result) => {
                setState({ status: result })
                const probe = result.ds.lastProbe
                setStatusText(
                  [
                    `浏览器：${result.browser.connected ? `已连通（${result.browser.browserVersion}）` : '未连通'}`,
                    `DS 页面：${result.ds.pageFound ? result.browser.pageUrl || '已打开' : '未打开'}`,
                    `DS 登录：${result.ds.pageFound ? (result.ds.loggedIn ? '已登录' : '未登录') : '(需先打开页面)'}`,
                    `服务端放行：${result.ds.allowed === null ? '未探测' : result.ds.allowed ? '是' : '否'}`,
                    probe === null ? '' : `最近探测：${probe.msg}`,
                    `投递模式：${result.config.mode}（已验 user=${result.ds.userModeSupported === null ? '未知' : String(result.ds.userModeSupported)}）`,
                    `专用会话：${result.ds.chatSessionId === '' ? '(未建立)' : result.ds.chatSessionId}`,
                    `缓存：${result.cache.files} 个 / ${(result.cache.bytes / 1024 / 1024).toFixed(1)} MB`,
                  ]
                    .filter((line) => line !== '')
                    .join(' · '),
                )
              })
              .catch((error: unknown) => setStatusText(error instanceof Error ? error.message : String(error)))
              .finally(() => setBusy(''))
          }}
        >
          状态自查
        </button>
        <button
          type="button"
          className="ds-tts-btn"
          disabled={busy !== ''}
          title="清掉专用会话记录，下次朗读会新建一个 DS 会话（用于会话太长时重开）"
          onClick={() => {
            void update({ chatSessionId: '' }).then(() => addToast('已重置专用会话，下次朗读会新建'))
          }}
        >
          重建朗读会话
        </button>
      </div>

      {statusText === '' ? null : <div className="ds-tts-status">{statusText}</div>}
      <div className="ds-tts-hint">
        首次使用需要在 ds-tts 拉起的专用浏览器里登录一次 chat.deepseek.com；之后朗读/导出全自动。
      </div>
    </div>
  )
}

/**
 * 包样式（apply 时注入一次）。
 *
 * 色值策略：一律 `var(--dsw-…, 官方 boot 值)`。fallback 用的是官方 boot 调色板的真值
 * （明色 #0f1115 / #61666b / #81858c、边框 rgb(0 0 0 / 10%)、brand #0f1115），
 * 因为 GUI 一定会定义 `--dsw-*`，fallback 只在极端情况下兜底；暗色由 GUI 自己的令牌接管。
 * **刻意不再使用任何自造彩色**（旧版那颗 #4c9aff 蓝喇叭已删除）。
 */
export const CSS = `
.ds-tts-layer { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; }
.ds-tts-layer > * { pointer-events: auto; }
/* 与官方动作行同几何：官方 .xzv4MW_actions 是 height≈28px、gap 8px，图标 16px 描边体系 */
.ds-tts-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; padding: 0; border: none; background: transparent; color: var(--dsw-alias-label-secondary, #61666b); cursor: pointer; border-radius: 6px; }
.ds-tts-icon-btn:hover:not(:disabled) { background: var(--dsw-specific-tip, rgba(0,0,0,.06)); color: var(--dsw-alias-label-primary, #0f1115); }
.ds-tts-icon-btn:disabled { opacity: .35; cursor: default; }
/* 朗读中用官方单色 brand 表示"正在出声"，不再用彩色 */
.ds-tts-icon-btn--on { color: var(--dsw-alias-brand-primary, #0f1115); }
.ds-tts-icon-pair { display: inline-flex; align-items: center; gap: 2px; }
.ds-tts-spin { display: inline-flex; align-items: center; justify-content: center; animation: ds-tts-spin 1s linear infinite; }
@keyframes ds-tts-spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }
.ds-tts-bar { position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%); display: flex; align-items: center; gap: 10px; padding: 6px 12px; border-radius: 999px; background: var(--dsw-alias-label-primary, #0f1115); color: var(--dsw-alias-bg-base, #fff); font-size: 12px; box-shadow: 0 6px 22px rgba(0,0,0,.28); max-width: 78vw; }
.ds-tts-bar-icon { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; }
.ds-tts-bar-icon--spin { animation: ds-tts-spin 1s linear infinite; }
.ds-tts-bar-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ds-tts-bar-stop { display: inline-flex; align-items: center; gap: 4px; border: 1px solid currentColor; background: transparent; color: inherit; border-radius: 999px; padding: 2px 10px; font-size: 12px; cursor: pointer; opacity: .85; }
.ds-tts-bar-stop:hover { opacity: 1; }
.ds-tts-toasts { position: fixed; left: 50%; bottom: 150px; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 8px; }
.ds-tts-toast { background: var(--dsw-alias-label-primary, #0f1115); color: var(--dsw-alias-bg-base, #fff); border-radius: 8px; padding: 8px 14px; font-size: 13px; max-width: 74vw; box-shadow: 0 4px 16px rgba(0,0,0,.24); word-break: break-all; }
.ds-tts-toast--error { background: #8c1d24; color: #fff; }
/* 遮罩：官方写法（--dsw-alias-bg-mask-1 + --dsw-mask-blur）。之前我手搓 rgba 且面板用了不存在的令牌。 */
.ds-tts-modal-backdrop { position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; background: var(--dsw-alias-bg-mask-1, rgba(0, 0, 0, .24)); backdrop-filter: var(--dsw-mask-blur, blur(2px)); }
/* 面板：官方弹层用 bg-layer-2 + elevation-prominent。
   ⚠️ 关键教训：--dsw-alias-bg-elevated 在官方 357 个令牌里并不存在，用它会让回退链落到
   bg-base（页面底色）→ 面板与页面同色，看起来像"没有面板、糊在一起"。 */
.ds-tts-modal { width: min(660px, 94vw); background: var(--dsw-alias-bg-layer-2, #fff); color: var(--dsw-alias-label-primary, #0f1115); border: 0; border-radius: 16px; box-shadow: var(--dsw-elevation-prominent, 0 0 0 .5px rgba(0, 0, 0, .16)), 0 18px 48px rgba(0, 0, 0, .24); display: flex; flex-direction: column; overflow: hidden; }
/* 令牌万一缺失也不至于看不清：按官方主题选择器给暗色兜底 */
body[data-ds-dark-theme] .ds-tts-modal { background: var(--dsw-alias-bg-layer-2, #23232a); color: var(--dsw-alias-label-primary, #f9fafb); }
/* 头部：图标 + 标题 + 关闭 */
.ds-tts-modal-head { display: flex; align-items: center; gap: 9px; padding: 13px 14px; border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); }
.ds-tts-modal-glyph { display: inline-flex; color: var(--dsw-alias-label-secondary, #61666b); }
.ds-tts-modal-title { font-size: 13.5px; font-weight: 600; }
.ds-tts-modal-head .ds-tts-icon-btn { margin-left: auto; }
/* 双栏主体：左编辑、右参数（评审回执 modal-b） */
.ds-tts-modal-body { display: flex; gap: 0; align-items: stretch; }
.ds-tts-modal-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; padding: 14px; }
.ds-tts-modal-side { width: 210px; flex: none; border-left: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); padding: 14px; display: flex; flex-direction: column; gap: 11px; }
@media (max-width: 560px) { .ds-tts-modal-body { flex-direction: column } .ds-tts-modal-side { width: auto; border-left: none; border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)) } }
.ds-tts-field { display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #61666b); }
/* 设置行沿用的横排标签（弹窗用竖排的 .ds-tts-field） */
.ds-tts-modal-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ds-tts-label { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, #61666b); }
.ds-tts-label--grow { flex: 1; }
.ds-tts-modal-meta { display: flex; justify-content: space-between; font-size: 11px; color: var(--dsw-alias-label-tertiary, #81858c); }
.ds-tts-textarea { width: 100%; box-sizing: border-box; resize: vertical; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); background: transparent; color: inherit; padding: 10px 11px; font-size: 13px; line-height: 1.7; font-family: inherit; }
.ds-tts-textarea:focus { outline: none; border-color: var(--dsw-alias-label-primary, #0f1115); }
/* 底部：主行动唯一实底，其余 ghost / quiet */
.ds-tts-modal-foot { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-top: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); }
.ds-tts-spacer { flex: 1; }
.ds-tts-select, .ds-tts-input { width: 100%; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); background: transparent; color: inherit; padding: 5px 7px; font-size: 12px; font-family: inherit; }
.ds-tts-input { min-width: 220px; }
.ds-tts-input--num { min-width: 84px; width: 84px; }
.ds-tts-btn { border-radius: 9px; border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.10)); background: transparent; color: var(--dsw-alias-label-secondary, #61666b); padding: 7px 14px; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
.ds-tts-btn:hover:not(:disabled) { background: var(--dsw-specific-tip, rgba(0,0,0,.06)); color: var(--dsw-alias-label-primary, #0f1115); }
.ds-tts-btn:disabled { opacity: .45; cursor: default; }
.ds-tts-btn--primary { background: var(--dsw-alias-brand-primary, #0f1115); border-color: transparent; color: var(--dsw-alias-bg-base, #fff); font-weight: 600; }
.ds-tts-btn--primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary, #0f1115); color: var(--dsw-alias-bg-base, #fff); opacity: .88; }
.ds-tts-btn--quiet { border-color: transparent; padding-left: 6px; padding-right: 6px; }
.ds-tts-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--dsw-alias-label-secondary, #61666b); }
.ds-tts-settings { display: flex; flex-direction: column; gap: 8px; padding: 8px 0; font-size: 13px; }
.ds-tts-settings-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-weight: 600; }
.ds-tts-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, #81858c); }
.ds-tts-status { font-size: 11px; line-height: 1.6; color: var(--dsw-alias-label-secondary, #61666b); word-break: break-all; border-left: 2px solid var(--dsw-alias-brand-primary, #0f1115); padding-left: 8px; }
`
