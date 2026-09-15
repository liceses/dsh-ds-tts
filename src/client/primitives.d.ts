/**
 * `@deepseek-ai/dsh-client-ui-primitives` 的类型 shim。
 *
 * 为什么需要 shim：这个包在**本机是悬空 junction**（`profiles/node_modules/@deepseek-ai/`
 * 下的链接指向 dsh 安装里并不存在的目录），磁盘上没有实体可解析类型。
 * 但它在**运行时是壳的平台模块**：壳把实现打进了
 * `dsh-web-frontend/dist/assets/index-*.js`（在那里面完整枚举到 **75 个** `Icon*` 导出），
 * 浏览器侧的冻结模块表会提供它（构建时保持 external，见 scripts/build-client.mjs）。
 *
 * 下面只声明**实际用到的成员**，名字全部来自那次完整枚举。即便如此，运行时仍做
 * 存在性检查（见 icons.tsx）：名字一旦对不上就退到内联图标，绝不因一个图标名白屏。
 *
 * 顺带记录：官方图标集**没有**喇叭/音量类图标；朗读那两个图标改用 DS 网页端自带的素材（见 icons.tsx 的 SpeakerGlyph / PlayingBars）。
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ReactElement, SVGProps } from 'react'

  /** 官方图标组件的 props（就是普通 svg 属性）。 */
  export type OfficialIconProps = SVGProps<SVGSVGElement>

  /** 一个官方图标组件。 */
  export type OfficialIcon = (props: OfficialIconProps) => ReactElement

  export const IconStopFill16: OfficialIcon
  export const IconLoadingOutline16: OfficialIcon
  export const IconDownloadOutline16: OfficialIcon
  export const IconRefreshOutline16: OfficialIcon
  export const IconCloseOutline16: OfficialIcon
}
