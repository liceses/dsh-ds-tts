/**
 * 播放器：全局单实例 `<audio>`。
 *
 * 刻意**不**回退到浏览器 `speechSynthesis`：用户要的是 DS 官方音色，
 * 混进系统合成音只会造成"读出来的不是我要的声音"的困惑。失败就明确报错。
 */

/** 播放回调。 */
export interface PlayerCallbacks {
  /** 播放自然结束。 */
  onEnded?: () => void
  /** 播放/暂停/结束等状态变化。 */
  onStateChange?: (playing: boolean) => void
  /** 播放出错。 */
  onError?: (message: string) => void
}

/** 单实例播放器。 */
class Player {
  private audio: HTMLAudioElement | undefined
  private callbacks: PlayerCallbacks = {}
  private currentUrl = ''

  /**
   * 播放一个 URL（自动停掉上一个）。
   * @param url - 同源音频 URL。
   * @param callbacks - 回调。
   * @returns 是否成功开始播放。
   */
  async play(url: string, callbacks: PlayerCallbacks = {}): Promise<boolean> {
    this.stop()
    this.callbacks = callbacks
    this.currentUrl = url
    const audio = new Audio(url)
    this.audio = audio
    audio.addEventListener('ended', () => {
      if (this.audio !== audio) return
      this.callbacks.onStateChange?.(false)
      this.callbacks.onEnded?.()
      this.audio = undefined
      this.currentUrl = ''
    })
    audio.addEventListener('error', () => {
      if (this.audio !== audio) return
      this.callbacks.onError?.('音频播放失败（文件可能已被清理）')
      this.callbacks.onStateChange?.(false)
      this.audio = undefined
      this.currentUrl = ''
    })
    try {
      await audio.play()
      this.callbacks.onStateChange?.(true)
      return true
    } catch (error) {
      this.callbacks.onError?.(`无法播放音频：${error instanceof Error ? error.message : String(error)}`)
      this.audio = undefined
      this.currentUrl = ''
      return false
    }
  }

  /** 停掉当前播放。 */
  stop(): void {
    const audio = this.audio
    this.audio = undefined
    this.currentUrl = ''
    if (audio !== undefined) {
      try {
        audio.pause()
        audio.src = ''
      } catch {
        // ignore
      }
    }
    this.callbacks.onStateChange?.(false)
  }

  /** 当前是否在播放。 */
  get isPlaying(): boolean {
    return this.audio !== undefined && !this.audio.paused && this.currentUrl !== ''
  }

  /** 直接播放一个公开试听地址（DS CDN，不需要合成）。 */
  async playUrl(url: string, callbacks: PlayerCallbacks = {}): Promise<boolean> {
    return await this.play(url, callbacks)
  }
}

/** 全局播放器实例。 */
export const player = new Player()

/**
 * 触发浏览器下载一个同源音频。
 * @param url - 音频 URL。
 * @param fileName - 建议文件名。
 */
export function downloadAudio(url: string, fileName: string): void {
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = fileName
  anchor.rel = 'noopener'
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
}
