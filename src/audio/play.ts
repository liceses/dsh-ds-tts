/**
 * 宿主扬声器播放（工具的 `play: true` 选项，默认关闭）。
 *
 * 用 ffplay 播文件；不可用时明确返回 played:false + note，绝不假装成功。
 */
import { spawn } from 'node:child_process'

/** 播放结果。 */
export interface HostPlayResult {
  played: boolean
  /** 未播放时的原因。 */
  note: string
}

/**
 * 在宿主扬声器上播放一个音频文件。
 * @param filePath - 音频文件绝对路径。
 * @param ffplayPath - ffplay 路径（空串=用 PATH 上的 ffplay）。
 * @param waitMs - 判定"已开始播放"的等待毫秒。
 * @returns 是否开始播放与说明。
 */
export async function playOnHost(filePath: string, ffplayPath: string, waitMs = 700): Promise<HostPlayResult> {
  const executable = ffplayPath !== '' ? ffplayPath : 'ffplay'
  return await new Promise<HostPlayResult>((resolve) => {
    let settled = false
    const done = (result: HostPlayResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      const child = spawn(executable, ['-nodisp', '-autoexit', '-loglevel', 'error', filePath], {
        stdio: 'ignore',
        detached: true,
        windowsHide: true,
      })
      child.on('error', (error: Error) => done({ played: false, note: `无法执行 ${executable}：${error.message}` }))
      child.unref()
      setTimeout(() => done({ played: true, note: '' }), waitMs)
    } catch (error) {
      done({ played: false, note: error instanceof Error ? error.message : String(error) })
    }
  })
}
