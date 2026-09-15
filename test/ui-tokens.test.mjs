/**
 * 评审回执的回归守卫。
 *
 * 这些断言对应你在评审页上给出的明确决定，不是我的审美偏好：
 *   q2 同意 → 去掉自造彩色，强调色用官方单色 brand
 *   btn-c 要改 → "正在合成/朗读"直接用官方图标，不再自绘
 * 谁要是哪天把蓝喇叭改回来、或把官方图标换成自绘，这些用例会红。
 */
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const UI = readFileSync(new URL('../src/client/ui.tsx', import.meta.url), 'utf8')
const ICONS = readFileSync(new URL('../src/client/icons.tsx', import.meta.url), 'utf8')
const SHIM = readFileSync(new URL('../src/client/primitives.d.ts', import.meta.url), 'utf8')

/** 取 ui.tsx 里的 CSS 模板块（注释不算）。 */
function cssBlock() {
  const start = UI.indexOf('export const CSS = `')
  assert.ok(start > 0, 'ui.tsx 里应该有 CSS 模板')
  return UI.slice(start)
}

test('q2：CSS 里不再出现自造强调色（蓝）', () => {
  const css = cssBlock()
  assert.ok(!/#4c9aff/i.test(css), 'CSS 里不该还有 #4c9aff —— 改回蓝色会让 UI 又不像官方的')
  assert.ok(!/#8a8f98|#9aa1ac|#7f8792/i.test(css), '文档里的旧 fallback 灰也该换成官方 boot 值')
})

test('q2：强调色改用官方 brand 令牌', () => {
  const css = cssBlock()
  const hits = css.match(/var\(--dsw-alias-brand-primary/g) ?? []
  assert.ok(hits.length >= 2, `主按钮与"朗读中"都该用 brand 令牌，实际出现 ${hits.length} 次`)
  assert.ok(/--dsw-alias-bg-base, #fff/.test(css), 'primary 按钮的前景色应该取自 bg-base 令牌')
})

test('q2：fallback 色值是官方 boot 调色板的真值', () => {
  const css = cssBlock()
  assert.ok(css.includes('#0f1115'), '明色 label-primary/brand 应为 #0f1115')
  assert.ok(css.includes('#61666b'), '明色 label-secondary 应为 #61666b')
  assert.ok(css.includes('#81858c'), '明色 label-tertiary 应为 #81858c')
})

test('btn-c：合成/停止/下载/关闭用官方 primitives 图标，且 shim 声明一致', () => {
  // 官方图标名（来自壳 bundle 的完整枚举）
  for (const name of ['IconStopFill16', 'IconLoadingOutline16', 'IconDownloadOutline16', 'IconCloseOutline16']) {
    assert.ok(ICONS.includes(name), `icons.tsx 应使用官方 ${name}`)
    assert.ok(SHIM.includes(`export const ${name}`), `primitives.d.ts 应声明 ${name}`)
  }
  // 每个官方图标都必须有内联兜底，否则运行时缺失会白屏
  const picks = ICONS.match(/pick\('/g) ?? []
  assert.ok(picks.length >= 4, `每个官方图标都应经 pick() 兜底，实际 ${picks.length} 处`)
  // 不再使用 IconPlayOutline16（朗读待命态改用 DS 网页端原版素材）
  assert.ok(!/IconPlayOutline16/.test(ICONS), 'IconPlayOutline16 已被 DS 网页端喇叭素材取代')
  assert.ok(!/IconPlayOutline16/.test(SHIM), 'shim 不该再声明用不到的 IconPlayOutline16')
})

test('朗读两个状态用 DS 网页端原版素材（未播放喇叭 / 播放中柱状动画）', () => {
  // 未播放：喇叭三段 path 的特征片段
  assert.ok(ICONS.includes('export function SpeakerGlyph'), '应有 SpeakerGlyph（DS 网页端未播放素材）')
  assert.ok(/M9\.31006 14\.8936/.test(ICONS), 'SpeakerGlyph 应是 DS 网页端原版 path 数据')
  assert.ok(/M13\.4306 2\.67302/.test(ICONS), 'SpeakerGlyph 应包含最外层声波 path')
  // 播放中：四根柱子 + SMIL 动画（原样保留 dur/负 begin 错峰）
  assert.ok(ICONS.includes('export function PlayingBars'), '应有 PlayingBars（DS 网页端播放中素材）')
  assert.ok(/values="14;4;14"/.test(ICONS), '柱状动画的 height 关键帧应原样保留')
  assert.ok(/keySplines="0\.42 0 0\.58 1;0\.42 0 0\.58 1"/.test(ICONS), '缓动应原样保留')
  assert.ok(/dur="1\.6s"/.test(ICONS), '时长应原样保留')
  assert.ok(/-1\.2s/.test(ICONS) && /-0\.8s/.test(ICONS) && /-0\.4s/.test(ICONS), '四根柱子应保持错峰 begin')
  // 播放中是"状态指示"，按钮本身仍可点击停止 —— 所以不能把它写成 IconStop 的替代语义
  assert.ok(/状态指示/.test(ICONS), '注释里应说明播放中素材是状态指示、点击仍为停止')
})

test('接 DS 网页端素材时只做了两处必要改动（去类名 + currentColor）', () => {
  // DS 网页的 CSS module 类名在 DSH 里不存在，必须剥掉
  assert.ok(!/_01eb1ae/.test(ICONS), '不该残留 DS 网页的 CSS module 类名 _01eb1ae')
  assert.ok(!/ce087d9d|a0949194/.test(ICONS), '不该残留 DS 网页的类名 ce087d9d / a0949194')
  // 原先靠类名上色，接过来必须显式继承主题色。
  // 注意：切片会带上下一个函数的文档注释（注释里也提到 fill="currentColor"），所以先剥注释。
  const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '')
  const speaker = stripComments(
    ICONS.slice(ICONS.indexOf('export function SpeakerGlyph'), ICONS.indexOf('/**\n * 朗读·播放中')),
  )
  const fills = (speaker.match(/fill="currentColor"/g) ?? []).length
  assert.equal(fills, 3, `SpeakerGlyph 的三段 path 都应带 fill="currentColor"，实际 ${fills}`)
  assert.equal((speaker.match(/<path/g) ?? []).length, 3, 'SpeakerGlyph 应恰好三段 path（与原版一致）')
  const bars = stripComments(ICONS.slice(ICONS.indexOf('export function PlayingBars'), ICONS.indexOf('/** 停止')))
  assert.ok(/fill="currentColor"/.test(bars), 'PlayingBars 的柱子应带 fill="currentColor"')
  assert.equal((bars.match(/<rect/g) ?? []).length, 1, '四根柱子由一次数组映射渲染（一个 <rect> 模板）')
})

test('官方没有的图标：自绘的必须写明"官方图标集里没有"', () => {
  // SaveGlyph 是唯一长期保留的自绘图标（存到工作区），必须在注释里交代原因
  assert.ok(/SaveGlyph/.test(ICONS))
  assert.ok(/没有对应语义|没有.*喇叭|逐名筛过|没有任何喇叭/.test(ICONS), '自绘图标必须注明"官方图标集里没有"')
})

test('入口按钮是纯图标（q1 同意），不再带"朗读文字"文案', () => {
  const composer = UI.slice(UI.indexOf('export function ComposerAskButton'), UI.indexOf('/** 弹窗里可选音色'))
  assert.ok(composer.length > 0, '应该能找到 ComposerAskButton 实现')
  assert.ok(!/<span>朗读文字<\/span>/.test(composer), 'q1 同意 = 入口不再显示文字标签')
  assert.ok(/aria-label=/.test(composer), '纯图标必须给 aria-label')
})

test('弹窗是双栏（modal-b 选这个 / q6 不同意单栏）', () => {
  assert.ok(/ds-tts-modal-body/.test(UI), '应有双栏容器')
  assert.ok(/ds-tts-modal-main/.test(UI) && /ds-tts-modal-side/.test(UI), '双栏 = 主区 + 侧栏')
  const css = cssBlock()
  assert.ok(/\.ds-tts-modal-side\s*\{[^}]*border-left/.test(css), '侧栏应有分隔线')
})

test('主行动唯一实底（why-4：不再四个等权重按钮）', () => {
  const cssStart = UI.indexOf('export const CSS = `')
  const footStart = UI.indexOf('ds-tts-modal-foot')
  assert.ok(footStart > 0 && footStart < cssStart, '应该能定位到弹窗底部那段 JSX（在 CSS 之前）')
  const foot = UI.slice(footStart, cssStart)
  const primary = (foot.match(/ds-tts-btn--primary/g) ?? []).length
  assert.equal(primary, 1, `底部只应有 1 个实底主按钮，实际 ${primary}`)
  assert.ok(/ds-tts-btn--quiet/.test(foot), '"存到工作区"应降为最弱一级（q4 同意）')
  // 另外两条行动是 ghost（无修饰类）
  const ghost = (foot.match(/className="ds-tts-btn"/g) ?? []).length
  assert.ok(ghost >= 1, '下载应是 ghost 按钮')
})

/* ─────────────────── 令牌存在性（"看不清"的那个 bug） ───────────────────
 *
 * 实测事故：弹窗面板写了 `var(--dsw-alias-bg-elevated, var(--dsw-alias-bg-base, #fff))`，
 * 而 `--dsw-alias-bg-elevated` **在官方 357 个令牌里根本不存在** → 回退链落到 bg-base
 * （页面底色）→ 面板与页面同色，只压在一层黑幕上，看起来"没有面板、糊在一起"。
 * CSS 变量拼错不会报错、只会静默回退，所以必须用测试兜住。
 */

/** 已核验存在于官方令牌表的白名单（新增令牌前先去 dsh-client-ui-theme 里核验再登记）。 */
const OFFICIAL_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-mask-1',
  '--dsw-alias-border-l2',
  '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-elevation-prominent',
  '--dsw-mask-blur',
  '--dsw-specific-tip',
])

/** 去掉 CSS 注释后的样式块（注释里会提到被废弃的令牌名）。 */
function cssNoComments() {
  return cssBlock().replace(/\/\*[\s\S]*?\*\//g, '')
}

test('只用官方确实存在的 --dsw-* 令牌（拼错会静默回退成错色）', () => {
  const used = [...new Set([...cssNoComments().matchAll(/var\((--dsw-[a-z0-9-]+)/g)].map((m) => m[1]))].sort()
  const unknown = used.filter((t) => !OFFICIAL_TOKENS.has(t))
  assert.deepEqual(
    unknown,
    [],
    `这些令牌没在官方令牌表里核验过：${unknown.join(', ')}。先确认它真的存在（dsh-client-ui-theme 的 client.js），再加进 OFFICIAL_TOKENS`,
  )
})

test('弹窗面板用官方弹层令牌，且不再出现不存在的 bg-elevated', () => {
  const css = cssNoComments()
  const modalRule = /\.ds-tts-modal \{[^}]*\}/.exec(css)?.[0] ?? ''
  assert.ok(modalRule.length > 0, '应该能定位到 .ds-tts-modal 规则')
  assert.ok(/--dsw-alias-bg-layer-2/.test(modalRule), '面板底色必须用官方的 bg-layer-2')
  assert.ok(/--dsw-elevation-prominent/.test(modalRule), '面板抬升必须用官方的 elevation-prominent')
  assert.ok(!/bg-elevated/.test(css), '--dsw-alias-bg-elevated 不存在，禁止再用')
})

test('遮罩用官方 mask 令牌 + 官方模糊（不再手搓 rgba）', () => {
  const css = cssNoComments()
  const backdrop = /\.ds-tts-modal-backdrop \{[^}]*\}/.exec(css)?.[0] ?? ''
  assert.ok(/--dsw-alias-bg-mask-1/.test(backdrop), '遮罩应用 --dsw-alias-bg-mask-1')
  assert.ok(/--dsw-mask-blur/.test(backdrop), '遮罩应带 --dsw-mask-blur')
})

test('暗色下也有兜底（官方主题选择器 body[data-ds-dark-theme]）', () => {
  const css = cssNoComments()
  assert.ok(
    /body\[data-ds-dark-theme\]\s+\.ds-tts-modal/.test(css),
    '令牌缺失时暗色会白底白字，必须有暗色兜底规则',
  )
})
