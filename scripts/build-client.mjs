/**
 * 构建浏览器半：src/client/index.ts → lib/client.js。
 *
 * 产物形态必须与 dsh-client-modules 的加载契约一致：
 *   window.__ModuleLoader__.load({ id: <包名>, factory: (require) => { ... } })
 * 其中 `id` 必须**严格等于 package.json 的包名**（dsh-client-modules 用包名作为
 * 图行 id 与 /plugins/<id>/client.js 的 id，不匹配会在启动时报
 * "bundle ... loaded without registering ..."）。
 *
 * 平台模块（react / slots / runtime）保持 external —— 由浏览器侧冻结的模块表提供。
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { readFileSync, mkdirSync } from 'node:fs'

const root = fileURLToPath(new URL('..', import.meta.url))
mkdirSync(root + 'lib', { recursive: true })

const pkg = JSON.parse(readFileSync(root + 'package.json', 'utf8'))
const PLUGIN_ID = pkg.name

const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots',
  // 官方图标在这个平台模块里（官方 bundle 也是以该说明符从模块表取它）。
  // 本机它是悬空 junction、没有实体可读，所以类型见 src/client/primitives.d.ts 的 shim，
  // 运行时在 icons.tsx 里做存在性检查 + 内联兜底。
  '@deepseek-ai/dsh-client-ui-primitives',
]

const result = await build({
  entryPoints: [root + 'src/client/index.ts'],
  outfile: root + 'lib/client.js',
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2020'],
  sourcemap: true,
  logLevel: 'warning',
  external: PLATFORM_MODULES,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  banner: {
    js:
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {\n` +
      'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: {
    js: 'return module.exports; } });',
  },
})

if (result.errors.length > 0) process.exit(1)
console.log(`client bundle written to lib/client.js (id=${PLUGIN_ID})`)
