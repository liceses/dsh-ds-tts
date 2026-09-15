/**
 * Markdown → 口播文本归一化。
 *
 * 助手回复是 Markdown，直接丢给 TTS 会把 ``` / 链接 / 表格线 / emoji 逐字符念出来。
 * 这里把它压成"能听懂的散文"：去代码围栏、去链接与裸 URL、去 HTML、压平表格、
 * 去列表符号与强调标记、去 emoji与零宽字符、折叠空白，最后按 maxChars 在句末截断。
 *
 * 纯函数、无 IO、无依赖 —— 是单测的主要靶子。
 */

/** 归一化统计（诊断用，不进音频）。 */
export interface NormalizeStats {
  /** 被整段丢弃的代码围栏数量。 */
  codeBlocks: number
  /** 被压成纯文本的链接数量。 */
  links: number
  /** 被整段丢弃的图片数量。 */
  images: number
  /** 被压平的表格行数。 */
  tableRows: number
  /** 被丢弃的裸 URL 数量。 */
  bareUrls: number
}

/** 归一化结果。 */
export interface NormalizeResult {
  /** 归一化后的口播文本；全是被丢弃内容时为空串。 */
  text: string
  /** 是否因超过 maxChars 被截断。 */
  truncated: boolean
  /** 原始字符数。 */
  originalChars: number
  /** 统计。 */
  stats: NormalizeStats
}

/** emoji / 符号区段（JS 层面用显式码点区间，避免依赖 Unicode 属性转义的可移植性）。 */
const SYMBOL_RANGES =
  /[\u2190-\u21FF\u2300-\u23FF\u2460-\u24FF\u25A0-\u27BF\u2B00-\u2BFF\uFE0F\u200D\u20E3\u3030\u303D\u3297\u3299]/g
/** 星面 emoji 与补充符号（代理对区间）。 */
const ASTRAL_EMOJI = /[\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}]/gu
/** 零宽 / 方向控制 / BOM。 */
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g

/**
 * 在句末边界截断（找不到就硬截），避免把半句话读出来。
 * @param text - 已归一化文本。
 * @param maxChars - 上限。
 * @returns 截断后的文本与是否发生截断。
 */
function truncateAtSentence(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  const window = text.slice(0, maxChars)
  const enders = ['。', '！', '？', '!', '?', '；', ';', '\n', '.', '，', ',']
  let cut = -1
  for (const ender of enders) {
    const at = window.lastIndexOf(ender)
    if (at > cut) cut = at
  }
  // 句末点太靠前（< 一半）就别用，免得只读出一小截
  const body = cut >= Math.floor(maxChars / 2) ? window.slice(0, cut + 1) : window
  return { text: body.trimEnd(), truncated: true }
}

/**
 * 把 Markdown 正文压成适合朗读的纯文本。
 * @param input - 原始 Markdown 文本。
 * @param maxChars - 归一化后的长度上限（在句末截断）。
 * @returns 归一化结果。
 */
export function normalizeForSpeech(input: string, maxChars: number): NormalizeResult {
  const stats: NormalizeStats = { codeBlocks: 0, links: 0, images: 0, tableRows: 0, bareUrls: 0 }
  const originalChars = input.length
  let text = input.replace(/\r\n?/g, '\n').replace(INVISIBLE, '')

  // 1) 代码围栏整段丢弃（含未闭合的尾巴）
  text = text.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*?^[ \t]*\1[ \t]*$/gm, () => {
    stats.codeBlocks += 1
    return ''
  })
  text = text.replace(/^[ \t]*(```|~~~)[^\n]*\n[\s\S]*$/m, () => {
    stats.codeBlocks += 1
    return ''
  })
  text = text.replace(/(```|~~~)/g, '')

  // 2) 图片与链接
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, () => {
    stats.images += 1
    return ''
  })
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, (_m, label: string) => {
    stats.links += 1
    return label
  })
  text = text.replace(/<(https?:\/\/[^>\s]+)>/g, () => {
    stats.bareUrls += 1
    return ''
  })
  text = text.replace(/\bhttps?:\/\/[^\s<>()"']+/g, () => {
    stats.bareUrls += 1
    return ''
  })

  // 3) HTML 标签
  text = text.replace(/<\/?[A-Za-z][^>\n]{0,300}>/g, '')

  // 4) 块级标记
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
  text = text.replace(/^[ \t]*>[ \t]?/gm, '')
  text = text.replace(/^[ \t]*([-*_][ \t]*){3,}$/gm, '')

  // 5) 表格压平：外层竖线去掉，分隔行丢掉，其余单元用顿号连接
  text = text
    .split('\n')
    .map((line) => {
      const trimmed = line.trim()
      if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return line
      stats.tableRows += 1
      const cells = trimmed
        .slice(1, -1)
        .split('|')
        .map((cell) => cell.trim())
        .filter((cell) => cell !== '' && !/^:?-{2,}:?$/.test(cell))
      return cells.join('，')
    })
    .join('\n')

  // 6) 列表符号
  text = text.replace(/^[ \t]*([-*+]|\d{1,3}[.)])[ \t]+/gm, '')

  // 7) 强调 / 行内代码 / 删除线
  text = text
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/~~([^~\n]+)~~/g, '$1')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/(^|[\s(（])_([^_\n]+)_(?=[\s)）]|$)/g, '$1$2')

  // 8) emoji 与杂符号
  text = text.replace(ASTRAL_EMOJI, '').replace(SYMBOL_RANGES, '')

  // 9) 折叠空白：逐行 trim、丢空行、压连续空格
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n')
    .trim()

  const { text: finalText, truncated } = truncateAtSentence(text, maxChars)
  return { text: finalText, truncated, originalChars, stats }
}

/**
 * 生成用于比对/匹配的宽松指纹：去空白、去标点、统一大小写。
 * @param text - 任意文本。
 * @returns 指纹串。
 */
export function looseFingerprint(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/[\p{P}\p{S}]/gu, '')
    .toLowerCase()
}
