/**
 * MockEngine — local, profile-driven stand-in for a model (SIMULADO). It is the ONLY engine that
 * sees the expected answer, through `oracle(itemId)`; nothing it produces is a measurement.
 *
 * Determinism: every call draws from its own RNG seeded with (seed, engine, itemId, repetition)
 * and always consumes the same number of draws, so a seed reproduces the run exactly and an item
 * never shifts the randomness of another. Without a label (quick test) the "true" category is
 * picked by hashing the concept, so the answer is still deterministic.
 */
import type {
  Category,
  ClassificationTask,
  ClassifyAnswer,
  ClassifyResult,
  ConceptInput,
  Difficulty,
  EngineId,
} from '../shared/contracts.ts'
import { buildCanonicalPrompt, serializeConcept } from '../shared/task.ts'
import { createRng, hashSeed, logNormal, type Rng } from '../bench/rng.ts'
import { abortableDelay, abortedResult, failedResult } from './abort.ts'
import { MOCK_PROFILES, mergeProfile, type DeepPartial, type MockLatencyProfile, type MockProfile } from './profiles.ts'
import type { ClassifyOptions, Engine, Oracle } from './types.ts'

export type SleepFn = (ms: number, signal: AbortSignal) => Promise<void>

export interface MockEngineOptions {
  /** Label lookup. Missing / unknown item → unlabeled (hash-based) answer. */
  oracle?: Oracle
  /** Run seed (BenchConfig.seed). Defaults to 0. */
  seed?: number
  /** Overrides on top of MOCK_PROFILES[id]. */
  profile?: DeepPartial<MockProfile>
  /** Waits the simulated latency. Defaults to `abortableDelay` (injectable for tests). */
  sleep?: SleepFn
}

/** Upper bound for the calibrated wrong-probability (chosen category keeps ≥ 30 % of the mass). */
const MAX_WRONG_PROBABILITY = 0.7
/** Calibrated models never claim 100 % certainty. */
const MIN_WRONG_PROBABILITY = 0.002
/** Weight of the expected category in the leftover mass when the calibrated mock errs. */
const TRUTH_WEIGHT = 4
const SIBLING_WEIGHT = 2

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value))
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000
}

function lerp(range: { min: number; max: number }, u: number): number {
  return range.min + u * (range.max - range.min)
}

function pick<T>(items: readonly T[], u: number): T {
  return items[Math.min(items.length - 1, Math.floor(u * items.length))]
}

/** Simulated provider latency. Always consumes 4 draws. */
export function sampleLatencyMs(latency: MockLatencyProfile, rng: Rng): number {
  const body = logNormal(rng, latency.medianMs, latency.sigma)
  const spikeRoll = rng()
  const spikeMagnitude = rng()
  const raw = spikeRoll < latency.spikeProbability ? latency.medianMs * lerp(latency.spikeMultiplier, spikeMagnitude) : body
  return Math.round(clamp(raw, latency.minMs, latency.maxMs))
}

/**
 * Largest wrong-probability that keeps the chosen category the argmax of its distribution, for
 * `n` categories (worst case: every other weight 1 except the expected one).
 */
function maxWrongProbability(n: number): number {
  if (n <= 1) return 0
  const ratio = TRUTH_WEIGHT / (TRUTH_WEIGHT + (n - 2))
  return Math.min(MAX_WRONG_PROBABILITY, 1 / (1 + ratio) - 0.02)
}

/**
 * Per-item wrong-probability for a calibrated model: a latent "difficulty" with mean `mean`
 * (so the long-run error rate matches the profile), shaped as mean × (1 + (3u² − 1)·s).
 */
function latentWrongProbability(mean: number, u: number, max: number): number {
  const m = clamp(mean, 0, max)
  if (m === 0) return 0
  const spread = Math.min(1, (max - m) / (2 * m))
  const factor = 1 + (3 * u * u - 1) * spread
  return clamp(m * factor, Math.min(MIN_WRONG_PROBABILITY, m), max)
}

function sameGroup(a: Category, b: Category): boolean {
  return a.group !== undefined && a.group !== '' && a.group === b.group
}

/** A plausible wrong category: a sibling (same group) most of the time, else any other one. */
function pickWrongCategory(categories: readonly Category[], truth: Category, groupRoll: number, u: number, sameGroupRate: number): Category {
  const others = categories.filter((c) => c.id !== truth.id)
  if (others.length === 0) return truth
  const siblings = others.filter((c) => sameGroup(c, truth))
  return siblings.length > 0 && groupRoll < sameGroupRate ? pick(siblings, u) : pick(others, u)
}

/** Distribution over all categories: `chosen` gets `peak`, the rest split by weight. Sums to exactly 1. */
function buildProbabilities(categories: readonly Category[], chosen: Category, truth: Category, peak: number): Record<string, number> {
  const others = categories.filter((c) => c.id !== chosen.id)
  const weight = (c: Category): number => (c.id === truth.id ? TRUTH_WEIGHT : sameGroup(c, chosen) ? SIBLING_WEIGHT : 1)
  const totalWeight = others.reduce((sum, c) => sum + weight(c), 0)
  const top = round4(peak)
  const remaining = 1 - top
  const out: Record<string, number> = {}
  let assigned = 0
  for (const c of categories) {
    if (c.id === chosen.id) {
      out[c.id] = top
      continue
    }
    out[c.id] = round4((remaining * weight(c)) / totalWeight)
    assigned += out[c.id]
  }
  // Absorb the rounding residual in the chosen category so the sum is 1.
  out[chosen.id] = round4(1 - assigned)
  return out
}

function estimateInputTokens(task: ClassificationTask, item: ConceptInput, overhead: number): number {
  return Math.ceil(JSON.stringify(buildCanonicalPrompt(task, item)).length / 4) + overhead
}

export class MockEngine implements Engine {
  readonly id: EngineId
  readonly mode = 'mock' as const
  readonly model: string
  readonly profile: MockProfile
  private readonly oracle: Oracle | undefined
  private readonly seed: number
  private readonly sleep: SleepFn

  constructor(id: EngineId, options: MockEngineOptions = {}) {
    this.id = id
    this.profile = mergeProfile(MOCK_PROFILES[id], options.profile)
    this.model = this.profile.model
    this.oracle = options.oracle
    this.seed = options.seed ?? 0
    this.sleep = options.sleep ?? abortableDelay
  }

  async classify(task: ClassificationTask, item: ConceptInput, opts: ClassifyOptions): Promise<ClassifyResult> {
    const { signal } = opts
    if (signal.aborted) return abortedResult(this.id, 'mock', this.model, signal)
    let result: ClassifyResult
    try {
      result = this.simulate(task, item, opts.repetition ?? 0)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      return failedResult(this.id, 'mock', this.model, 'error', `Error del simulador: ${detail}`)
    }
    try {
      await this.sleep(result.providerLatencyMs ?? 0, signal)
    } catch {
      return abortedResult(this.id, 'mock', this.model, signal)
    }
    if (signal.aborted) return abortedResult(this.id, 'mock', this.model, signal)
    return result
  }

  /** The whole simulated answer, computed up front (pure; the wait happens in `classify`). */
  simulate(task: ClassificationTask, item: ConceptInput, repetition = 0): ClassifyResult {
    const profile = this.profile
    const categories = task.categories
    const rng = createRng(hashSeed(this.seed, this.id, item.id, repetition))

    // Fixed draw order: 4 for the latency + these 8 (see the file header).
    const latencyMs = sampleLatencyMs(profile.latency, rng)
    const transientRoll = rng()
    const invalidRoll = rng()
    const latentDraw = rng()
    const correctRoll = rng()
    const groupRoll = rng()
    const wrongPick = rng()
    const confidenceDraw = rng()
    const nativeDraw = rng()

    const serialized = serializeConcept(item)
    const base = {
      engine: this.id,
      mode: 'mock' as const,
      model: this.model,
      providerLatencyMs: latencyMs,
      estimated: true,
    }
    const request = { item: serialized, simulated: true }

    if (transientRoll < profile.transientErrorRate) {
      const errorMessage = 'Error simulado del proveedor (HTTP 503)'
      return failedResult(this.id, 'mock', this.model, 'error', errorMessage, {
        ...base,
        attempts: [{ attempt: 1, status: 503, ms: latencyMs, error: errorMessage }],
        raw: { request, response: { simulated: true, error: errorMessage } },
      })
    }

    const inputTokens = estimateInputTokens(task, item, profile.promptOverheadTokens)
    const outputTokens = profile.outputTokens
    const usage = { inputTokens, outputTokens }
    const costUsd = (inputTokens * profile.prices.inputPerMTok + outputTokens * profile.prices.outputPerMTok) / 1_000_000
    const attempts = [{ attempt: 1, status: 200, ms: latencyMs }]

    if (invalidRoll < profile.invalidRate || categories.length === 0) {
      return failedResult(this.id, 'mock', this.model, 'invalid', 'Respuesta simulada fuera del conjunto de categorías', {
        ...base,
        usage,
        costUsd,
        attempts,
        raw: { request, response: { simulated: true, categoryId: 'N/A' } },
      })
    }

    // Expected category: the label (oracle) or, unlabeled, a stable hash of the concept.
    const labeled = this.oracle?.(item.id)
    let truth = labeled ? categories.find((c) => c.id === labeled.expected) : undefined
    let difficulty: Difficulty = labeled?.difficulty ?? 'medium'
    if (!truth) {
      truth = categories[hashSeed('unlabeled', this.seed, JSON.stringify(serialized)) % categories.length]
      difficulty = 'medium'
    }

    const answer: ClassifyAnswer = { categoryId: null }
    const accuracy = clamp(profile.accuracy[difficulty], 0, 1)
    if (profile.confidence.kind === 'calibrated') {
      const wrongProbability = latentWrongProbability(1 - accuracy, latentDraw, maxWrongProbability(categories.length))
      const wrong = correctRoll < wrongProbability
      const chosen = wrong ? pickWrongCategory(categories, truth, groupRoll, wrongPick, profile.sameGroupErrorRate) : truth
      const probabilities = buildProbabilities(categories, chosen, truth, 1 - wrongProbability)
      const n = categories.length
      answer.categoryId = chosen.id
      answer.probabilities = probabilities
      answer.confidence = probabilities[chosen.id]
      // Jev's Choice statistic: (n·p − 1) / (n − 1), not a probability.
      answer.nativeConfidence = round4(clamp((n * probabilities[chosen.id] - 1) / Math.max(1, n - 1), 0, 1))
      answer.nativeConfidenceKind = 'jev_confidence'
    } else {
      const wrong = correctRoll < 1 - accuracy
      const chosen = wrong ? pickWrongCategory(categories, truth, groupRoll, wrongPick, profile.sameGroupErrorRate) : truth
      const band = wrong ? profile.confidence.wrong : profile.confidence.correct
      answer.categoryId = chosen.id
      answer.confidence = Math.round(lerp(band, confidenceDraw) * 100) / 100
      // Token logprob of the chosen id: very high either way (informative only).
      answer.nativeConfidence = round4(wrong ? 0.8 + nativeDraw * 0.19 : 0.97 + nativeDraw * 0.0299)
      answer.nativeConfidenceKind = 'logprob'
    }

    return {
      ...base,
      status: 'ok',
      answer,
      usage,
      costUsd,
      attempts,
      raw: { request, response: { simulated: true, categoryId: answer.categoryId, confidence: answer.confidence } },
    }
  }
}
