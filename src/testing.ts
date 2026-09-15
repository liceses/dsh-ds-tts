/**
 * 测试入口（只给本仓库的单测用，不在 package.json 的 exports 里对外暴露）。
 *
 * 宿主半是 esbuild 打成的单文件 bundle，测试没法按源文件 import；所以这里显式
 * 再导出一份"内部零件"给 `node --test` 用。生产代码不 import 本文件。
 */
export { Config, ConfigStore, toView } from './config.ts'
export { TtsEngine } from './engine.ts'
export { makeRoutes, MAX_BODY_BYTES } from './routes.ts'
export { makeTools } from './tools.ts'
export { normalizeForSpeech, looseFingerprint } from './ds/text.ts'
export { describeHistoryRows, isFinishedStatus, normalizeHistoryRow, normalizeHistoryRows, pickNewMessage } from './ds/history.ts'
export { resolveAttemptOrder } from './ds/mode.ts'
export {
  DS_CODE_MAP,
  RETRY_AS_ECHO_CODES,
  ackFrame,
  assembleFrames,
  decodeFrame,
  mapDsCode,
  parseControlFrame,
  parseVoices,
  unwrapEnvelope,
} from './ds/frames.ts'
export { audioUrlWithVersion, audioVersion, cacheId, cacheStats, pruneCache, readCache, shouldReadCache, writeCache } from './audio/cache.ts'
export { contentTypeOf, pcmDurationSeconds, pcmToWav, probeAudioMagic, wavDurationSeconds } from './audio/wav.ts'
export { isOggContainer } from './audio/convert.ts'
export { chooseWorkTarget, dsOriginReady, isDsUrl, sessionIdFromUrl } from './browser/page.ts'
export * from './routes-shared.ts'
