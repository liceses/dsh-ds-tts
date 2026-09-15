/**
 * DSH home 路径解析。
 *
 * 刻意不引 `@deepseek-ai/dsh-home-paths`：本包以 link: 方式装进 profile，
 * pnpm 不会为它建 node_modules，任何非内联依赖都可能解析不到；而这里需要的
 * 只是"$DSH_HOME 优先、否则 ~/.dsh"这一条规则，五行就够。
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 解析 DSH home（`$DSH_HOME` 优先，空白串视为未设置；否则 `~/.dsh`）。
 * @returns 绝对路径。
 */
export function resolveDshHome(): string {
  const raw = process.env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') return resolve(raw.trim())
  return join(homedir(), '.dsh')
}

/**
 * 在 DSH home 下拼路径。
 * @param segments - 追加的路径段。
 * @returns 绝对路径。
 */
export function dshPath(...segments: string[]): string {
  return join(resolveDshHome(), ...segments)
}

/** 本插件在 DSH home 下的私有目录名。 */
export const DS_TTS_DIR_NAME = 'ds-tts'

/**
 * 在本插件私有目录下拼路径。
 * @param segments - 追加的路径段。
 * @returns 绝对路径。
 */
export function dsTtsPath(...segments: string[]): string {
  return dshPath(DS_TTS_DIR_NAME, ...segments)
}

/** 用户覆盖配置文件的绝对路径（`$DSH_HOME/ds-tts/config.json`）。 */
export function configFilePath(): string {
  return dsTtsPath('config.json')
}

/** 内容寻址缓存目录（`$DSH_HOME/ds-tts/cache`）。 */
export function cacheDirPath(): string {
  return dsTtsPath('cache')
}

/** ds-tts 专用浏览器 profile 目录（`$DSH_HOME/ds-tts/browser`）。 */
export function browserProfilePath(): string {
  return dsTtsPath('browser')
}
