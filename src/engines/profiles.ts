/**
 * Mock engine profiles (SIMULADO mode).
 *
 * IMPORTANT — these numbers are PARAMETERS, NOT MEASUREMENTS. They were chosen so a simulated run
 * looks plausible (a slower, overconfident LLM vs. a faster model with calibrated probabilities)
 * and say NOTHING about how GPT or Jev really perform. Only live mode measures anything; the UI
 * must label mock runs as SIMULADO (see MOCK_DISCLAIMER).
 */
import type { Difficulty, EngineId } from '../shared/contracts.ts'

/** Spanish disclaimer for the UI. */
export const MOCK_DISCLAIMER =
  'Modo SIMULADO: latencias, aciertos y confianzas salen de parámetros ilustrativos, no de mediciones de los modelos reales.'

export interface MockLatencyProfile {
  /** Median of the log-normal body, in ms. */
  medianMs: number
  /** Log-space standard deviation of the body. */
  sigma: number
  /** Hard clamp (applied after spikes), in ms. */
  minMs: number
  maxMs: number
  /** Probability that a call is a latency spike (replaces the log-normal body). */
  spikeProbability: number
  /** A spike lasts medianMs × uniform(min, max). */
  spikeMultiplier: { min: number; max: number }
}

/**
 * - 'overconfident': verbalized confidence in a narrow high band, almost unrelated to correctness
 *   (correct answers draw from `correct`, wrong ones from `wrong`).
 * - 'calibrated': a full distribution over the categories; the chosen category's probability is the
 *   confidence and the engine errs with exactly 1 − confidence (calibrated by construction).
 */
export type MockConfidenceModel =
  | { kind: 'overconfident'; correct: { min: number; max: number }; wrong: { min: number; max: number } }
  | { kind: 'calibrated' }

export interface MockProfile {
  /** Model reported in ClassifyResult.model. */
  model: string
  latency: MockLatencyProfile
  /** P(correct) by difficulty (items without difficulty count as 'medium'). */
  accuracy: Record<Difficulty, number>
  /** When wrong and the expected category has siblings (same `group`), P(picking a sibling). */
  sameGroupErrorRate: number
  /** P(answer outside the category set) → status 'invalid'. */
  invalidRate: number
  /** P(transient provider failure) → status 'error'. */
  transientErrorRate: number
  confidence: MockConfidenceModel
  /** Estimated output tokens per call. */
  outputTokens: number
  /** Estimated tokens added on top of the canonical prompt (system text, output format). */
  promptOverheadTokens: number
  /** Illustrative USD per million tokens. */
  prices: { inputPerMTok: number; outputPerMTok: number }
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K]
}

export const MOCK_PROFILES: Readonly<Record<EngineId, MockProfile>> = {
  // GPT-like: ~900 ms median with a heavy tail, good on easy items, weaker on hard ones,
  // verbalized and overconfident (0.85–0.98 whether right or wrong).
  gpt: {
    model: 'mock-gpt',
    latency: { medianMs: 900, sigma: 0.45, minMs: 250, maxMs: 9000, spikeProbability: 0.03, spikeMultiplier: { min: 3, max: 6 } },
    accuracy: { easy: 0.95, medium: 0.8, hard: 0.55 },
    sameGroupErrorRate: 0.7,
    invalidRate: 0.01,
    transientErrorRate: 0.005,
    confidence: { kind: 'overconfident', correct: { min: 0.88, max: 0.98 }, wrong: { min: 0.85, max: 0.95 } },
    outputTokens: 18,
    promptOverheadTokens: 120,
    prices: { inputPerMTok: 0.4, outputPerMTok: 1.6 },
  },
  // Jev-like: ~300 ms median, slightly better on medium/hard, calibrated probabilities over the categories.
  jev: {
    model: 'mock-jev',
    latency: { medianMs: 300, sigma: 0.35, minMs: 80, maxMs: 2000, spikeProbability: 0.02, spikeMultiplier: { min: 1.8, max: 2.6 } },
    accuracy: { easy: 0.95, medium: 0.82, hard: 0.6 },
    sameGroupErrorRate: 0.75,
    invalidRate: 0,
    transientErrorRate: 0.002,
    confidence: { kind: 'calibrated' },
    outputTokens: 6,
    promptOverheadTokens: 60,
    prices: { inputPerMTok: 0.042, outputPerMTok: 0 },
  },
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function merge(base: unknown, patch: unknown): unknown {
  if (patch === undefined) return base
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) out[key] = merge(base[key], value)
  }
  return out
}

/** New profile with `overrides` merged key by key on top of `base` (nested objects too). */
export function mergeProfile(base: MockProfile, overrides?: DeepPartial<MockProfile>): MockProfile {
  return merge(base, overrides) as MockProfile
}
