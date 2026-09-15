/**
 * 模型可见工具：tts_speak / tts_voices / tts_status。
 *
 * 设计要点：
 * - **产物是真实文件**：`tts_speak` 默认把音频写到 `$DSH_HOME/ds-tts/out/`（或用
 *   `out` 指定绝对路径/目录），返回绝对路径供模型 `present` 或后续处理。
 *   刻意不去猜"当前会话工作区"：工具层没有可靠的 session 面，UI 侧的"存到工作区"
 *   走 `/export` 路由（那里有 sessionId）。
 * - **预期内失败返回 `ok:false` 而不是抛错**：一次 TTS 失败不该结束整个回合。
 * - **协作式取消**：把 `exec.signal` 透给引擎，模型/用户取消时能及时停手。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ConfigStore } from './config.ts'
import type { TtsEngine } from './engine.ts'
import { cacheDirPath, dsTtsPath } from './paths.ts'
import { AUDIO_EXTS } from './protocol.ts'
import { playOnHost } from './audio/play.ts'

/** 工具依赖。 */
export interface ToolDeps {
  engine: TtsEngine
  config: ConfigStore
  log: (message: string, data?: unknown) => void
}

/** 输出 schema 的公共字段（每个工具各自声明一遍，保持自解释）。 */
const OK_FIELDS = {
  ok: { type: 'boolean', required: true, description: '是否成功' },
  error: { type: 'string', description: '失败原因（中文）' },
  code: { type: 'string', description: '结构化错误码，例如 NO_BROWSER / NOT_LOGGED_IN / DS_QUOTA' },
  note: { type: 'string', description: '补充说明（诊断细节等）' },
} as const

/** 判断某个路径是否以音频扩展名结尾。 */
function looksLikeAudioFile(path: string): boolean {
  const ext = extname(path).replace(/^\./, '').toLowerCase()
  return (AUDIO_EXTS as readonly string[]).includes(ext)
}

/**
 * 造出全部 ds-tts 工具。
 * @param deps - 引擎/配置/日志。
 * @returns 工具定义数组（交给 `ctx.tools.register`）。
 */
export function makeTools(deps: ToolDeps) {
  const ttsSpeak = defineTool({
    name: 'tts_speak',
    description: [
      '用 DeepSeek 官方朗读音色把一段文字合成语音，并保存为音频文件。',
      '音色固定为 DS 官方四选一：mira(贝壳/女/默认)、echo(白浪/男)、stella(海星/女)、tide(暗潮/男)。',
      '实现方式：先由真实浏览器把文本投递进一个 ds-tts 专用 DeepSeek 会话，再走 DS 官方 ticket + WebSocket 取音频。',
      '因此需要：① DS 专用浏览器在运行且已登录 chat.deepseek.com；② 首次调用会比较慢（投递 + 合成，数秒到数十秒），相同文本第二次会秒回缓存。',
      '注意：DS 官方 TTS **每次合成的声音可能不同**；默认走缓存（同文本秒回同一版），想再要一版就传 regenerate=true。',
      '文本会先做 Markdown 归一化（丢弃代码块/链接/表格线，不朗读它们）；超过 maxChars 会在句末截断，此时 truncated=true。',
      '返回的 path 是可直接使用的绝对音频路径（wav/mp3/opus），可用 present 交付给用户。',
      '失败时返回 ok=false 与中文 error，不会抛错。',
    ].join('\n'),
    parameters: {
      text: { type: 'string', required: true, description: '要朗读的文字（可以是 Markdown）' },
      voice: {
        type: 'string',
        description: '音色 voice_id，缺省用配置里的音色。可选 mira / echo / stella / tide',
      },
      format: {
        type: 'string',
        enum: ['pcm', 'opus'],
        description: "合成格式：'pcm' → 落地为无损 WAV（默认）；'opus' → 体积小（有 ffmpeg 且服务端给 Ogg 时会转 MP3）",
      },
      out: {
        type: 'string',
        description: '输出路径。绝对路径且以音频扩展名结尾 → 当作目标文件；否则当作输出目录。缺省写 $DSH_HOME/ds-tts/out/',
      },
      regenerate: {
        type: 'boolean',
        description: '强制重新合成（跳过缓存）。DS 每次合成的声音可能不同，想要新的一版就传 true；同一文本会覆盖旧那一版',
      },
      play: { type: 'boolean', description: '是否同时在宿主扬声器上播放（需要 ffplay），缺省 false' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...OK_FIELDS,
          path: { type: 'string', description: '音频文件绝对路径（成功时）' },
          voice: { type: 'string', description: '实际使用的音色' },
          ext: { type: 'string', description: '文件扩展名' },
          bytes: { type: 'number', description: '文件字节数' },
          seconds: { type: 'number', description: '音频时长（秒，估算）' },
          ms: { type: 'number', description: '本次耗时（毫秒）' },
          cached: { type: 'boolean', description: '是否命中缓存（true 表示没有重新投递/合成）' },
          regenerated: { type: 'boolean', description: '本次是否是显式要求的重新生成' },
          version: { type: 'string', description: '音频版本令牌（DS 侧 audio_id），重新生成后会变' },
          mode: { type: 'string', description: '投递模式：user（读你自己的话）或 echo（读模型回显）' },
          truncated: { type: 'boolean', description: '文本是否因超长被截断' },
          played: { type: 'boolean', description: '是否已在宿主扬声器播放' },
        },
      },
      render: (args, value) => {
        if (value.ok !== true) {
          return [{ type: 'text', text: `朗读失败：${value.error ?? '未知错误'}${value.code === undefined ? '' : `（${value.code}）`}` }]
        }
        const lines = [
          `已生成音频：${value.path ?? ''}`,
          `音色 ${value.voice ?? '-'} · ${value.ext ?? '-'} · ${((value.bytes ?? 0) / 1024).toFixed(1)} KB · ${(value.seconds ?? 0).toFixed(1)} 秒 · 耗时 ${value.ms ?? 0} ms${value.cached === true ? '（缓存命中）' : ''}${value.regenerated === true ? '（重新生成）' : ''}`,
          `投递模式 ${value.mode ?? '-'}${value.truncated === true ? ' · 文本已按上限截断' : ''}`,
        ]
        if (args.play === true) lines.push(value.played === true ? '已在宿主扬声器播放' : '未能在宿主扬声器播放（缺 ffplay）')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const result = await deps.engine.synthesize(
        {
          text: args.text,
          ...(args.voice === undefined ? {} : { voice: args.voice }),
          ...(args.format === 'pcm' || args.format === 'opus' ? { format: args.format } : {}),
          ...(args.regenerate === true ? { regenerate: true } : {}),
        },
        exec.signal,
      )
      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          code: result.code,
          ...(result.detail === undefined ? {} : { note: result.detail }),
        }
      }
      // 把缓存里的音频复制成用户可见的产物
      const source = join(cacheDirPath(), `${result.id}.${result.ext}`)
      let target: string
      const out = args.out
      if (out !== undefined && out !== '' && isAbsolute(out) && looksLikeAudioFile(out)) {
        target = out
      } else if (out !== undefined && out !== '' && isAbsolute(out)) {
        target = join(out, `ds-tts-${Date.now().toString()}.${result.ext}`)
      } else if (out !== undefined && out !== '') {
        target = join(dsTtsPath('out'), out)
      } else {
        target = join(dsTtsPath('out'), `ds-tts-${Date.now().toString()}.${result.ext}`)
      }
      try {
        const bytes = await readFile(source)
        await mkdir(join(target, '..'), { recursive: true })
        await writeFile(target, bytes)
      } catch (error) {
        return {
          ok: false,
          error: `音频已合成但写文件失败：${error instanceof Error ? error.message : String(error)}`,
          code: 'CACHE_WRITE_FAILED',
          note: `缓存文件：${source}`,
        }
      }
      let played = false
      let playNote = ''
      if (args.play === true) {
        const cfg = await deps.config.view()
        const outcome = await playOnHost(target, cfg.ffplayPath)
        played = outcome.played
        playNote = outcome.note
      }
      deps.log('tts_speak 完成', { target, bytes: result.bytes, cached: result.cached, regenerated: result.regenerated })
      return {
        ok: true,
        path: target,
        voice: result.voice,
        ext: result.ext,
        bytes: result.bytes,
        seconds: result.seconds,
        ms: result.ms,
        cached: result.cached,
        regenerated: result.regenerated,
        version: result.version,
        mode: result.mode,
        truncated: result.truncated,
        played,
        ...(playNote === '' ? {} : { note: playNote }),
      }
    },
  })

  const ttsVoices = defineTool({
    name: 'tts_voices',
    description: '列出 DeepSeek 官方朗读音色（voice_id、中文名、性别、支持语言）以及账号当前音色。用于在调用 tts_speak 前选择合适的音色。',
    parameters: {
      refresh: { type: 'boolean', description: '跳过 1 小时缓存，强制重新向 DS 拉取' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...OK_FIELDS,
          currentVoiceId: { type: 'string', description: '账号当前朗读音色' },
          cached: { type: 'boolean', description: '是否来自缓存' },
          voices: {
            type: 'array',
            description: '音色列表',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                gender: { type: 'string' },
                description: { type: 'string' },
                languages: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        if (value.ok !== true) {
          return [{ type: 'text', text: `取音色列表失败：${value.error ?? '未知错误'}（${value.code ?? '-'}）` }]
        }
        const lines = (value.voices ?? []).map(
          (voice) => `- ${voice.id}（${voice.name}·${voice.gender}）${voice.description === '' ? '' : ` ${voice.description}`}${(voice.languages ?? []).length > 0 ? ` · ${(voice.languages ?? []).length.toString()} 种语言` : ''}`,
        )
        return [
          {
            type: 'text',
            text: [`当前音色：${value.currentVoiceId ?? '(未知)'}${value.cached === true ? '（缓存）' : ''}`, ...lines].join('\n'),
          },
        ]
      },
    },
    async execute(args) {
      const result = await deps.engine.voices(args.refresh === true)
      if (!result.ok) {
        return { ok: false, error: result.error, code: result.code, ...(result.detail === undefined ? {} : { note: result.detail }) }
      }
      return {
        ok: true,
        currentVoiceId: result.currentVoiceId ?? '',
        cached: result.cached,
        voices: result.voices.map((voice) => ({
          id: voice.id,
          name: voice.name,
          gender: voice.gender,
          description: voice.description,
          languages: [...voice.languages],
        })),
      }
    },
  })

  const ttsStatus = defineTool({
    name: 'tts_status',
    description: [
      '诊断 ds-tts 当前状态：DS 专用浏览器是否连通、页面里是否已登录 chat.deepseek.com、服务端是否对账号放行、已验证的投递模式、队列与缓存情况。',
      'tts_speak 报错时先调它，能直接定位是"浏览器没起""没登录"还是"账号未放行"。',
    ].join('\n'),
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...OK_FIELDS,
          browserConnected: { type: 'boolean' },
          browserVersion: { type: 'string' },
          pageUrl: { type: 'string' },
          pageFound: { type: 'boolean', description: '浏览器里是否已打开 DS 页面（与是否登录是两件事）' },
          loggedIn: { type: 'boolean' },
          userModeSupported: { type: 'string', description: 'true / false / unknown' },
          chatSessionId: { type: 'string' },
          pending: { type: 'number' },
          busy: { type: 'boolean' },
          cacheFiles: { type: 'number' },
          cacheBytes: { type: 'number' },
          cacheHits: { type: 'number' },
          cacheMisses: { type: 'number' },
        },
      },
      render: (_args, value) => {
        if (value.ok !== true) return [{ type: 'text', text: `状态查询失败：${value.error ?? '未知错误'}` }]
        return [
          {
            type: 'text',
            text: [
              `浏览器：${value.browserConnected === true ? `已连通（${value.browserVersion ?? '-'}）` : '未连通'}`,
              `DS 页面：${value.pageFound === true ? (value.pageUrl === undefined || value.pageUrl === '' ? '已打开' : value.pageUrl) : '未打开（点一次朗读会自动打开）'}`,
              `DS 登录：${value.pageFound === true ? (value.loggedIn === true ? '已登录' : '未登录') : '(需先打开页面)'}`,
              `投递模式：user=${value.userModeSupported ?? 'unknown'} · 专用会话 ${value.chatSessionId === '' ? '(未建立)' : value.chatSessionId}`,
              `队列：排队 ${value.pending ?? 0}${value.busy === true ? ' · 正在合成' : ''}`,
              `缓存：${value.cacheFiles ?? 0} 个文件 / ${(((value.cacheBytes ?? 0) / 1024 / 1024)).toFixed(1)} MB · 命中 ${value.cacheHits ?? 0} 次 / 未命中 ${value.cacheMisses ?? 0} 次`,
            ].join('\n'),
          },
        ]
      },
    },
    async execute() {
      const status = await deps.engine.status()
      return {
        ok: true,
        browserConnected: status.browser.connected,
        browserVersion: status.browser.browserVersion,
        pageUrl: status.browser.pageUrl,
        pageFound: status.ds.pageFound,
        loggedIn: status.ds.loggedIn,
        userModeSupported: status.ds.userModeSupported === null ? 'unknown' : String(status.ds.userModeSupported),
        chatSessionId: status.ds.chatSessionId,
        pending: status.queue.pending,
        busy: status.queue.active,
        cacheFiles: status.cache.files,
        cacheBytes: status.cache.bytes,
        cacheHits: status.cache.hits,
        cacheMisses: status.cache.misses,
      }
    },
  })

  return [ttsSpeak, ttsVoices, ttsStatus]
}
