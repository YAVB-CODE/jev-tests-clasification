import type { EngineId, EngineMode } from '../shared/contracts.ts'
import { MockEngine, type SleepFn } from './MockEngine.ts'
import { RemoteEngine } from './RemoteEngine.ts'
import type { FetchLike } from './http.ts'
import type { DeepPartial, MockProfile } from './profiles.ts'
import type { Engine, Oracle } from './types.ts'

export interface CreateEngineOptions {
  /** Mock only: run seed (BenchConfig.seed). */
  seed?: number
  /** Mock only: label lookup (the only place the expected answer is read). */
  oracle?: Oracle
  /** Mock only: profile overrides. */
  profile?: DeepPartial<MockProfile>
  /** Mock only: latency wait (tests). */
  sleep?: SleepFn
  /** Live only: fetch implementation (tests). */
  fetch?: FetchLike
}

/** 'mock' → MockEngine (SIMULADO, reads the oracle); 'live' → RemoteEngine (POST /api/classify). */
export function createEngine(id: EngineId, mode: EngineMode, opts: CreateEngineOptions = {}): Engine {
  if (mode === 'mock') return new MockEngine(id, { seed: opts.seed, oracle: opts.oracle, profile: opts.profile, sleep: opts.sleep })
  return new RemoteEngine(id, { fetch: opts.fetch })
}

export type { ClassifyOptions, Engine, Oracle } from './types.ts'
export { MockEngine, sampleLatencyMs } from './MockEngine.ts'
export type { MockEngineOptions, SleepFn } from './MockEngine.ts'
export { RemoteEngine, buildClassifyRequest } from './RemoteEngine.ts'
export type { RemoteEngineOptions } from './RemoteEngine.ts'
export { MOCK_DISCLAIMER, MOCK_PROFILES, mergeProfile } from './profiles.ts'
export type { DeepPartial, MockConfidenceModel, MockLatencyProfile, MockProfile } from './profiles.ts'
export { DEFAULT_PROVIDERS, HEALTH_TIMEOUT_MS, MODELS_TIMEOUT_MS, fetchHealth, fetchModels, offlineHealth } from './api.ts'
export type { ApiOptions, ModelsResult } from './api.ts'
export { ENGINE_NAMES, MODE_LABELS, SERVER_DEFAULT_MODEL, engineLabel } from './labels.ts'
export { TIMEOUT_ERROR_NAME, abortableDelay, createAbortError, createTimeoutError, isAbortError, isTimeoutAbort } from './abort.ts'
export type { FetchLike } from './http.ts'
