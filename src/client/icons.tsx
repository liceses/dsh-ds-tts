/**
 * 图标：**官方素材优先**，只有官方确实没有的才自绘。
 *
 * ## 官方图标集的事实（从壳的 bundle 里完整枚举出来的）
 *
 * 官方图标由平台模块 `@deepseek-ai/dsh-client-ui-primitives` 提供，实现被壳打进
 * `dsh-web-frontend/dist/assets/index-*.js`；在那里**完整枚举到 75 个 `Icon*` 导出**，
 * 命名规范 `<名><Outline|Fill><尺寸>`。本插件用到的：
 *
 *   IconLoadingOutline16（正在合成）/ IconStopFill16 / IconDownloadOutline16 / IconCloseOutline16
 *
 * ## 朗读那两个图标：来自 DS 网页端本身，不是 DSH 的图标集
 *
 * DSH 的 75 个官方图标里**没有**喇叭/音量类图标（逐名筛过）。但**DS 网页端的朗读按钮**
 * 自带一套两个状态的素材，用户从线上 DOM 里取出贴回，现已原样接入：
 *
 *   SpeakerGlyph  —— 未播放（喇叭 + 两道声波）
 *   PlayingBars   —— 播放中（四根柱子 SMIL 波动动画，`dur 1.6s`、负 begin 错峰）
 *
 * 只做了两处必要改动：去掉 DS 网页 CSS module 的类名（DSH 里不存在那些类），
 * 并给图元补 `fill="currentColor"`（原先靠类名上色），以便跟随 DSH 主题色。
 *
 * ## 官方 16px 图标的绘制约定（自绘兜底按它写）
 *
 * `width/height=16`、`viewBox="0 0 16 16"`、`fill="none"`、`stroke="currentColor"`、
 * `strokeWidth="1.31831"`、`strokeLinejoin/Linecap="round"`。
 *
 * ## 为什么要有存在性检查
 *
 * primitives 在本机是悬空 junction、无法类型检查，运行时由壳的模块表提供。
 * 名字一旦对不上，直接渲染 `undefined` 会让 React 抛错、插件边界崩掉。
 * 所以统一走 `pick()`：拿不到就退到内联等价物。
 */
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactElement, SVGProps } from 'react'

/** 官方 16px 图标的公共属性（与官方内联图标一致）。 */
export const OFFICIAL_16: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: '0 0 16 16',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.31831,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
}

/** 一个图标组件。 */
type IconComponent = (props: SVGProps<SVGSVGElement>) => ReactElement

/**
 * 取一个官方图标，缺失时退回内联实现。
 * @param name - primitives 里的导出名。
 * @param fallback - 内联等价物。
 * @returns 可安全渲染的图标组件。
 */
function pick(name: string, fallback: IconComponent): IconComponent {
  const candidate = (primitives as unknown as Record<string, unknown>)[name]
  return typeof candidate === 'function' ? (candidate as IconComponent) : fallback
}

/* ─────────────────── 内联兜底（只在官方图标拿不到时用） ─────────────────── */

/** 内联：停止。 */
function FallbackStop(): ReactElement {
  return (
    <svg {...OFFICIAL_16}>
      <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** 内联：加载中。 */
function FallbackLoading(): ReactElement {
  return (
    <svg {...OFFICIAL_16}>
      <path d="M8 2.2a5.8 5.8 0 1 1-5.8 5.8" />
    </svg>
  )
}

/** 内联：关闭。 */
function FallbackClose(): ReactElement {
  return (
    <svg {...OFFICIAL_16}>
      <path d="M4.4 4.4l7.2 7.2M11.6 4.4l-7.2 7.2" />
    </svg>
  )
}

/** 内联：重新生成（官方拿不到时的兜底）。 */
function FallbackRefresh(): ReactElement {
  return (
    <svg {...OFFICIAL_16}>
      <path d="M13.5 8a5.5 5.5 0 1 1-1.7-3.98" />
      <path d="M13.6 2.6v3.2h-3.2" />
    </svg>
  )
}

/** 内联：下载。 */
function FallbackDownload(): ReactElement {
  return (
    <svg {...OFFICIAL_16}>
      <path d="M8 2.8v7" />
      <path d="M5.4 7.2L8 9.8l2.6-2.6" />
      <path d="M3.2 12.6h9.6" />
    </svg>
  )
}

/* ───────────────────────────── 对外导出 ───────────────────────────── */

/**
 * 朗读·未播放：**DS 网页端朗读按钮的原版素材**（用户从线上 DOM 里取出并贴回）。
 *
 * 原样保留三段 path 的几何；只做两处必要改动：
 *   ① 去掉 DS 网页 CSS module 的类名（那些类在 DSH 里不存在），
 *   ② 给每条 path 显式 `fill="currentColor"`（原来靠类名上色），以便跟随 DSH 主题色。
 * @param props - 标准 svg 属性。
 */
export function SpeakerGlyph(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" {...props}>
      <path
        d="M9.31006 14.8936C9.30005 14.9767 9.26249 15.2257 9.03858 15.4171C8.95084 15.492 8.84784 15.5468 8.73682 15.5782C8.45324 15.6584 8.22543 15.5514 8.15088 15.5137C8.07158 15.4737 7.98931 15.4174 7.95068 15.3917L3.15479 12.1944H2.86572C2.50642 12.1944 2.18033 12.195 1.91358 12.1661C1.63391 12.1357 1.33732 12.0666 1.0669 11.8702C0.922729 11.7654 0.795709 11.6383 0.690919 11.4942C0.494309 11.2236 0.424376 10.9264 0.394044 10.6466C0.365138 10.3798 0.365724 10.0538 0.365724 9.69441V6.29206C0.365723 5.933 0.365196 5.60754 0.394044 5.34089C0.42437 5.06099 0.494281 4.76388 0.690919 4.49323C0.795763 4.34895 0.922602 4.22209 1.0669 4.11726C1.33741 3.92073 1.6338 3.85073 1.91358 3.82038C2.18033 3.79148 2.50642 3.79206 2.86572 3.79206H3.71826L7.91065 0.647532C7.95088 0.617359 8.03247 0.555178 8.11084 0.509836C8.18041 0.469607 8.41182 0.341459 8.71045 0.41511C8.79681 0.436447 8.87927 0.471498 8.95361 0.519602L9.0249 0.57136L9.10498 0.647532C9.27169 0.829111 9.30067 1.03833 9.30908 1.10847C9.31986 1.19842 9.31885 1.30131 9.31885 1.35163V14.6593C9.31885 14.7057 9.32069 14.8054 9.31006 14.8936ZM1.76611 9.69441C1.76611 10.0846 1.76686 10.3213 1.78565 10.4952C1.79436 10.5757 1.805 10.6216 1.81299 10.6466C1.81667 10.658 1.81947 10.6644 1.8208 10.6671C1.8219 10.6693 1.82275 10.671 1.82275 10.671C1.84121 10.6964 1.86377 10.7189 1.88916 10.7374C1.88916 10.7374 1.8908 10.7382 1.89307 10.7393C1.89569 10.7406 1.90216 10.7435 1.91358 10.7471C1.93852 10.7551 1.98446 10.7658 2.06494 10.7745C2.23879 10.7933 2.47538 10.795 2.86572 10.795H3.57959L7.91943 13.6876V2.3907L4.18408 5.19245H2.86572C2.47542 5.19245 2.23878 5.19317 2.06494 5.21198C1.98446 5.2207 1.93852 5.23134 1.91358 5.23933C1.90209 5.24302 1.8957 5.24584 1.89307 5.24714C1.89068 5.24833 1.88916 5.25007 1.88916 5.25007C1.86389 5.26851 1.84114 5.29117 1.82275 5.31648L1.8208 5.31941C1.8195 5.32203 1.81666 5.3285 1.81299 5.33991C1.805 5.36486 1.79436 5.4108 1.78565 5.49128C1.76682 5.66512 1.76611 5.90173 1.76611 6.29206V9.69441Z"
        fill="currentColor"
      />
      <path
        d="M11.2036 4.90008C12.9119 6.60839 12.9118 9.37826 11.2036 11.0866L10.2133 10.0964C11.3748 8.93476 11.3749 7.05189 10.2133 5.89032L11.2036 4.90008Z"
        fill="currentColor"
      />
      <path
        d="M13.4306 2.67302C16.3689 5.61129 16.3688 10.3753 13.4306 13.3136L12.4404 12.3234C14.8319 9.93183 14.8319 6.0548 12.4404 3.66326L13.4306 2.67302Z"
        fill="currentColor"
      />
    </svg>
  )
}

/**
 * 朗读·播放中：**DS 网页端朗读按钮的原版动画素材**（用户从线上 DOM 里取出并贴回）。
 *
 * 四根柱子的 SMIL 动画原样保留（`height 14→4→14`、`dur 1.6s`、负 `begin` 值形成错峰波动）。
 * 同样只去掉类名并补 `fill="currentColor"`。
 *
 * 注意：这是**状态指示**（正在出声），不是"停止"图标；按钮本身仍可点击以停止 ——
 * 与 DS 网页端的行为一致。
 * @param props - 标准 svg 属性。
 */
export function PlayingBars(props: SVGProps<SVGSVGElement>): ReactElement {
  const bars = [
    { x: 1, begin: '0s' },
    { x: 5, begin: '-1.2s' },
    { x: 9, begin: '-0.8s' },
    { x: 13, begin: '-0.4s' },
  ] as const
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" {...props}>
      {bars.map((bar) => (
        <rect key={bar.x} x={bar.x} y="1" width="2" height="14" rx="1" fill="currentColor">
          <animate
            attributeName="height"
            values="14;4;14"
            keyTimes="0;0.5;1"
            calcMode="spline"
            keySplines="0.42 0 0.58 1;0.42 0 0.58 1"
            dur="1.6s"
            begin={bar.begin}
            repeatCount="indefinite"
          />
          <animate
            attributeName="y"
            values="1;6;1"
            keyTimes="0;0.5;1"
            calcMode="spline"
            keySplines="0.42 0 0.58 1;0.42 0 0.58 1"
            dur="1.6s"
            begin={bar.begin}
            repeatCount="indefinite"
          />
        </rect>
      ))}
    </svg>
  )
}

/** 停止（官方 `IconStopFill16`，实心）。 */
export const IconStop: IconComponent = pick('IconStopFill16', FallbackStop)
/** 正在合成（官方 `IconLoadingOutline16`，配合 CSS 旋转）。 */
export const IconLoading: IconComponent = pick('IconLoadingOutline16', FallbackLoading)
/** 下载/导出（官方 `IconDownloadOutline16`）。 */
export const IconDownload: IconComponent = pick('IconDownloadOutline16', FallbackDownload)
/** 重新生成（官方 `IconRefreshOutline16`）。 */
export const IconRefresh: IconComponent = pick('IconRefreshOutline16', FallbackRefresh)
/** 关闭（官方 `IconCloseOutline16`）。 */
export const IconClose: IconComponent = pick('IconCloseOutline16', FallbackClose)

/**
 * 存到工作区（官方图标集里没有对应语义，按官方 16px 描边约定自绘）。
 * @param props - 标准 svg 属性。
 */
export function SaveGlyph(props: SVGProps<SVGSVGElement>): ReactElement {
  return (
    <svg {...OFFICIAL_16} {...props}>
      <path d="M3.3 3.3h6l3.4 3.4v6H3.3z" />
      <path d="M5.9 3.3v3.3h3.8V3.3" />
    </svg>
  )
}
