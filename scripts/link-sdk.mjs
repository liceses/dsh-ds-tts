#!/usr/bin/env node
/**
 * 把本机 DSH 安装里的 `@deepseek-ai/*` SDK 链接进本仓库的 node_modules，供**本地开发**
 * （类型检查 / 构建）使用。
 *
 * ## 为什么需要它
 *
 * 本插件是 DSH 的宿主插件：那些 SDK 由 dsh 运行时提供，所以它们在 package.json 里
 * **只声明为 peerDependencies**，committed 的配置里没有任何本机路径。
 *
 * 但本地 `tsc` / esbuild 需要真的解析到这些包的类型。从 registry 装又不行 ——
 * `@deepseek-ai/dsh-*` 的 rc 版存在 semver 预发布区间问题（传递依赖写的是 `^0.1.5`，
 * 匹配不到 `0.1.5-rc.x`），所以只能用本机 dsh 安装里已有的那一份。
 *
 * 这个脚本就是干这件事：在 `node_modules/@deepseek-ai/` 下建立指向本机 DSH 安装的目录联接
 * （Windows 用 junction，免管理员权限）。**不会动任何 committed 文件。**
 *
 * ## 用法
 *
 *   pnpm install          # 装普通依赖（esbuild / typescript / ws / @types / react）
 *   npm run link-sdk      # 再把 SDK 链进来
 *   npm run build && npm test
 *
 * 环境变量：`DSH_HOME`（默认 `~/.dsh`）；也可用 `DSH_SDK_DIR` 直接指定 `@deepseek-ai` 所在目录。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const scopeDir = join(root, 'node_modules', '@deepseek-ai')

/** 开发期需要的 SDK（与 package.json 的 peerDependencies 对应）。 */
const NEEDED = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-chat',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/schemastery',
]

/** 候选搜索目录（按优先级）。 */
function candidateRoots() {
  const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
    ? resolve(process.env.DSH_HOME.trim())
    : join(homedir(), '.dsh')
  const roots = []
  if (process.env.DSH_SDK_DIR !== undefined && process.env.DSH_SDK_DIR.trim() !== '') {
    roots.push(resolve(process.env.DSH_SDK_DIR.trim()))
  }
  // profile 级共享 node_modules（dsh 把 SDK junction 到这里，客户端包在 profile 目录下）
  roots.push(join(dshHome, 'profiles', 'node_modules', '@deepseek-ai'))
  // web profile 自己的 node_modules（dsh-client-runtime / dsh-client-ui-slots 在这里）
  roots.push(join(dshHome, 'profiles', 'web', 'node_modules', '@deepseek-ai'))
  // 直接指向 npm 全局的 dsh 安装
  const npmGlobal = process.env.APPDATA !== undefined ? join(process.env.APPDATA, 'npm', 'node_modules') : ''
  if (npmGlobal !== '') roots.push(join(npmGlobal, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai'))
  return roots
}

/**
 * 找一个已安装的 SDK 包的实际目录。
 * @param {string} pkgName - 形如 `@deepseek-ai/dsh-tools`。
 * @param {readonly string[]} roots - 候选 `@deepseek-ai` 目录。
 * @returns {string | undefined} 含 package.json 的真实路径。
 */
function locate(pkgName, roots) {
  const short = pkgName.split('/')[1]
  for (const base of roots) {
    const candidate = join(base, short)
    // 悬空 junction 会「存在」但没有 package.json —— 所以必须校验 package.json
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

const roots = candidateRoots()
console.log(`[link-sdk] 仓库：${root}`)
console.log(`[link-sdk] 候选 SDK 目录：`)
for (const r of roots) console.log(`  ${existsSync(r) ? '✓' : '×'} ${r}`)

mkdirSync(scopeDir, { recursive: true })

// 把候选根目录里出现的**所有**包名取并集，再逐个定位到"有 package.json 的那一份"。
// 为什么不只链 NEEDED 那 10 个：SDK 的 .d.ts 之间会互相 import 传递类型，
// 配合 tsconfig 的 preserveSymlinks，解析必须能全部落在本仓库 node_modules 里。
const names = new Set(NEEDED.map((pkg) => pkg.split('/')[1]))
for (const base of roots) {
  if (!existsSync(base)) continue
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (entry.isDirectory() || entry.isSymbolicLink()) names.add(entry.name)
  }
}

let linked = 0
const missing = []
const skipped = []
for (const short of [...names].sort()) {
  const pkg = `@deepseek-ai/${short}`
  const target = locate(pkg, roots)
  const linkPath = join(scopeDir, short)

  // 清掉旧链接（pnpm install 之后可能留下真目录或坏链接）
  try {
    rmSync(linkPath, { recursive: true, force: true })
  } catch {
    /* 目录被占用时留给下面的报错 */
  }

  if (target === undefined) {
    // NEEDED 里的必须找到；其余（本机悬空 junction 之类的个别包）跳过即可
    if (NEEDED.includes(pkg)) missing.push(short)
    else skipped.push(short)
    continue
  }
  try {
    symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
    linked += 1
  } catch (error) {
    console.error(`[link-sdk] ✗ ${short}：${error instanceof Error ? error.message : String(error)}`)
    if (NEEDED.includes(pkg)) missing.push(short)
  }
}

console.log(`[link-sdk] 已链接 ${linked} 个包${skipped.length > 0 ? `（跳过 ${skipped.length} 个在本机没有可用副本的）` : ''}`)
console.log(`[link-sdk] 例：${NEEDED.map((p) => p.split('/')[1]).join(', ')}`)

if (missing.length > 0) {
  console.error(`\n[link-sdk] 有 ${missing.length} 个必需包没找到：${missing.join(', ')}`)
  console.error('          请确认 dsh 已安装（这些包来自 dsh 自身），或设 DSH_SDK_DIR 直接指向 @deepseek-ai 目录。')
  process.exitCode = 1
} else {
  console.log('\n[link-sdk] 完成。现在可以 npm run typecheck / npm run build / npm test。')
}
