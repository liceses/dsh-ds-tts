/**
 * ds-tts — 宿主半（node half）。
 *
 * 装配三件事，全部只依赖官方 NPM SDK，不改 dsh 源码：
 *   1) `/api/ds-tts/*` HTTP 路由：文本进、音频出（+ 音色、状态、配置、导出、取消）
 *   2) 三个模型可见工具：`tts_speak` / `tts_voices` / `tts_status`
 *   3) 配置存储：Schemastery 部署默认值 ⊕ `$DSH_HOME/ds-tts/config.json` 热读覆盖层
 *
 * 引擎（DS 官方朗读通道 + CDP 投递）在 engine.ts，HTTP 关注点在 routes.ts。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { ConfigStore, type Config } from './config.ts'
import { TtsEngine } from './engine.ts'
import { makeRoutes, type SessionFace, type SessionQueryFace } from './routes.ts'
import { makeTools } from './tools.ts'
import { cacheDirPath } from './paths.ts'

/** 稳定的 cordis 插件名（与装配行的 id 一致）。 */
export const name = 'ds-tts'

/** 必需服务：工具注册表与 Web 服务器（缺一个就挂起本 fiber）。 */
export const inject = ['tools', 'webServer']

// 一次性把 value（schemastery schema）与同名 type（校验后的配置类型）都重导出去。
export { Config } from './config.ts'

/**
 * 装配 ds-tts。
 * @param ctx - 宿主插件上下文（tools / webServer / sessions / sessionQuery / sandboxPolicy）。
 * @param config - schemastery 校验后的部署配置。
 */
export function apply(ctx: Context, config: Config): void {
  const log = (message: string, data?: unknown): void => {
    // 只打诊断信息；token 永不经过这里（见 engine.takeToken）
    if (data === undefined) console.log(`[ds-tts] ${message}`)
    else console.log(`[ds-tts] ${message}`, data)
  }

  const store = new ConfigStore(config)
  const engine = new TtsEngine({ config: store, log })

  // 路由
  ctx.effect(() => {
    const routes = makeRoutes({
      engine,
      config: {
        view: () => store.view(),
        patch: (patch) => store.patch(patch),
      },
      cacheDir: cacheDirPath(),
      sessions: ctx.get('sessions') as SessionFace | undefined,
      sessionQuery: ctx.get('sessionQuery') as SessionQueryFace | undefined,
      sandboxPolicy: ctx.get('sandboxPolicy') as { workspaceRoot?: string } | undefined,
      log,
    })
    const disposers = routes.map((route) => ctx.webServer.register(route))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'ds-tts: http routes')

  // 工具
  ctx.effect(() => {
    const tools = makeTools({ engine, config: store, log })
    const disposers = tools.map((tool) => ctx.tools.register(tool))
    return () => {
      for (const dispose of disposers) dispose()
    }
  }, 'ds-tts: tools')

  // 预热配置（失败也不阻断：view() 每次都会按 mtime 重读）
  void store
    .load()
    .then(() => {
      const view = store.current()
      log('已就绪', {
        voice: view.voice,
        format: view.format,
        mode: view.mode,
        cacheDir: cacheDirPath(),
      })
    })
    .catch((error: unknown) => {
      log('配置预热失败（不影响使用）', error instanceof Error ? error.message : String(error))
    })
}
