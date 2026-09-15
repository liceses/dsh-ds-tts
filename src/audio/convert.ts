/**
 * 可选的 ffmpeg 转码。
 *
 * 只在"服务端给的是 Ogg 封装的 Opus"且本机有 ffmpeg 时用来产 MP3（体积小、好分享）。
 * 若服务端给的是**裸 Opus 包**（没有 Ogg 容器），ffmpeg 无法直接解，本模块会明确返回
 * 不转码，让调用方原样落 `.opus` —— 宁可不转，也不要产一个坏文件。
 */
import { spawn } from 'node:child_process'
import { probeAudioMagic } from './wav.ts'

/** 转码结果。 */
export interface ConvertResult {
  ok: boolean
  /** 失败或跳过的原因。 */
  detail: string
}

/**
 * 探测可用的 ffmpeg 可执行文件。
 * @param explicit - 配置里的显式路径（空串表示查 PATH）。
 * @returns 可执行文件路径；不可用时 undefined。
 */
export async function findFfmpeg(explicit: string): Promise<string | undefined> {
  const candidate = explicit !== '' ? explicit : 'ffmpeg'
  return await new Promise<string | undefined>((resolve) => {
    let settled = false
    try {
      const child = spawn(candidate, ['-hide_banner', '-version'], { stdio: 'ignore' })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try {
          child.kill()
        } catch {
          // ignore
        }
        resolve(undefined)
      }, 5000)
      child.on('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(undefined)
      })
      child.on('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(code === 0 ? candidate : undefined)
      })
    } catch {
      resolve(undefined)
    }
  })
}

/**
 * 跑一次 ffmpeg 转码。
 * @param ffmpeg - ffmpeg 可执行文件。
 * @param args - 参数数组。
 * @returns 是否成功与失败原因。
 */
async function runFfmpeg(ffmpeg: string, args: readonly string[]): Promise<ConvertResult> {
  return await new Promise<ConvertResult>((resolve) => {
    let stderr = ''
    let settled = false
    const done = (result: ConvertResult): void => {
      if (settled) return
      settled = true
      resolve(result)
    }
    try {
      const child = spawn(ffmpeg, [...args], { stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderr.length < 4000) stderr += chunk.toString('utf8')
      })
      child.on('error', (error: Error) => done({ ok: false, detail: `无法执行 ffmpeg：${error.message}` }))
      child.on('exit', (code) => {
        if (code === 0) done({ ok: true, detail: '' })
        else done({ ok: false, detail: `ffmpeg 退出码 ${String(code)}：${stderr.slice(-400)}` })
      })
    } catch (error) {
      done({ ok: false, detail: error instanceof Error ? error.message : String(error) })
    }
  })
}

/**
 * WAV → MP3。
 * @param ffmpeg - ffmpeg 可执行文件。
 * @param wavPath - 输入 WAV。
 * @param mp3Path - 输出 MP3。
 * @returns 转码结果。
 */
export async function encodeWavToMp3(ffmpeg: string, wavPath: string, mp3Path: string): Promise<ConvertResult> {
  return await runFfmpeg(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', wavPath, '-c:a', 'libmp3lame', '-q:a', '4', mp3Path])
}

/**
 * （Ogg 封装的）Opus → MP3。
 * @param ffmpeg - ffmpeg 可执行文件。
 * @param oggPath - 输入 Ogg/Opus。
 * @param mp3Path - 输出 MP3。
 * @returns 转码结果。
 */
export async function encodeOggToMp3(ffmpeg: string, oggPath: string, mp3Path: string): Promise<ConvertResult> {
  return await runFfmpeg(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', oggPath, '-c:a', 'libmp3lame', '-q:a', '4', mp3Path])
}

/**
 * 判断一段 Opus 负载是否带 Ogg 容器（决定 ffmpeg 能否直接吃）。
 * @param opusBytes - 服务端给的 Opus 负载。
 * @returns 是否可直接交给 ffmpeg。
 */
export function isOggContainer(opusBytes: Uint8Array): boolean {
  return probeAudioMagic(opusBytes) === 'opus'
}
