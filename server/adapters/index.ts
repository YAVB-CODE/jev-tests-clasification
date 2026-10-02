import type { ServerConfig } from '../env.ts'
import type { Adapters, FetchLike } from './common.ts'
import { createGptAdapter } from './gpt.ts'
import { createJevAdapter } from './jev.ts'

export type { Adapters, AttemptLog, ClassifyOptions, EngineAdapter, FetchLike } from './common.ts'
export { createGptAdapter, type GptAdapterDeps } from './gpt.ts'
export { createJevAdapter, type JevAdapterDeps } from './jev.ts'

/** Builds both adapters from the server config. Cheap and side-effect free: rebuild when `.env` changes. */
export function createAdapters(cfg: ServerConfig, deps: { fetch?: FetchLike } = {}): Adapters {
  return {
    gpt: createGptAdapter(cfg.gpt, deps),
    jev: createJevAdapter(cfg.jev, deps),
  }
}
