import { describe, expect, it } from 'vitest'
import type { ClassificationTask, ClassifyResult, Difficulty, LabeledConcept } from '../shared/contracts.ts'
import { TASK } from '../bench/testFixtures.ts'
import { createTimeoutError } from './abort.ts'
import { MockEngine, type SleepFn } from './MockEngine.ts'
import { MOCK_PROFILES } from './profiles.ts'

const noSleep: SleepFn = async () => undefined
const DIFFS: Difficulty[] = ['easy', 'medium', 'hard']

/** A bigger task (22 categories in 6 groups), like the seed dataset. */
const BIG_TASK: ClassificationTask = {
  instructions: 'Clasifica.',
  question: '¿Cuál?',
  categories: Array.from({ length: 22 }, (_, i) => ({
    id: `C${i}`,
    name: `Categoría ${i}`,
    description: '',
    ...(i < 20 ? { group: `G${i % 5}` } : {}),
  })),
}

function makePool(perDifficulty: number): LabeledConcept[] {
  const items: LabeledConcept[] = []
  for (const difficulty of DIFFS) {
    for (let i = 0; i < perDifficulty; i++) {
      const n = items.length
      items.push({ id: `x-${n}`, concept: `Concepto ${n}`, expected: BIG_TASK.categories[n % 22].id, difficulty })
    }
  }
  return items
}

const POOL = makePool(1500)
const ORACLE_MAP = new Map(POOL.map((i) => [i.id, i]))
const oracle = (id: string) => ORACLE_MAP.get(id)

function simulateAll(engine: MockEngine): Array<{ item: LabeledConcept; result: ClassifyResult }> {
  return POOL.map((item) => ({ item, result: engine.simulate(BIG_TASK, item, 0) }))
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

describe('MockEngine — determinism', () => {
  it('same (seed, engine, item, repetition) → same result; other repetition / seed → different draw', () => {
    const a = new MockEngine('gpt', { seed: 42, oracle })
    const b = new MockEngine('gpt', { seed: 42, oracle })
    const item = POOL[7]
    expect(a.simulate(BIG_TASK, item, 0)).toEqual(b.simulate(BIG_TASK, item, 0))
    const latencies = (engine: MockEngine, rep: number) => POOL.slice(0, 20).map((i) => engine.simulate(BIG_TASK, i, rep).providerLatencyMs)
    expect(latencies(a, 0)).not.toEqual(latencies(a, 1))
    expect(latencies(a, 0)).not.toEqual(latencies(new MockEngine('gpt', { seed: 43, oracle }), 0))
  })

  it('reports mock metadata and estimated usage / cost', async () => {
    const result = await new MockEngine('jev', { seed: 1, oracle, sleep: noSleep }).classify(BIG_TASK, POOL[0], { signal: new AbortController().signal })
    expect(result).toMatchObject({ engine: 'jev', mode: 'mock', model: 'mock-jev', estimated: true })
    expect(result.usage?.inputTokens).toBeGreaterThan(0)
    expect(result.costUsd).toBeGreaterThan(0)
    expect(new MockEngine('gpt').model).toBe('mock-gpt')
  })
})

describe('MockEngine — plausible distributions (parameters, not measurements)', () => {
  for (const id of ['gpt', 'jev'] as const) {
    it(`${id}: accuracy by difficulty matches the profile`, () => {
      const rows = simulateAll(new MockEngine(id, { seed: 42, oracle }))
      for (const difficulty of DIFFS) {
        const subset = rows.filter((r) => r.item.difficulty === difficulty && r.result.status === 'ok')
        const accuracy = subset.filter((r) => r.result.answer.categoryId === r.item.expected).length / subset.length
        expect(Math.abs(accuracy - MOCK_PROFILES[id].accuracy[difficulty])).toBeLessThan(0.04)
      }
    })

    it(`${id}: wrong answers are plausible (mostly a sibling of the same group)`, () => {
      const rows = simulateAll(new MockEngine(id, { seed: 7, oracle }))
      const groupOf = new Map(BIG_TASK.categories.map((c) => [c.id, c.group]))
      const wrong = rows.filter((r) => r.result.status === 'ok' && r.result.answer.categoryId !== r.item.expected && groupOf.get(r.item.expected))
      expect(wrong.length).toBeGreaterThan(100)
      const same = wrong.filter((r) => groupOf.get(r.result.answer.categoryId!) === groupOf.get(r.item.expected)).length / wrong.length
      expect(same).toBeGreaterThan(0.6)
      expect(rows.every((r) => r.result.status !== 'ok' || BIG_TASK.categories.some((c) => c.id === r.result.answer.categoryId))).toBe(true)
    })
  }

  it('gpt: overconfident verbalized confidence in [0.85, 0.98]', () => {
    const rows = simulateAll(new MockEngine('gpt', { seed: 3, oracle })).filter((r) => r.result.status === 'ok')
    const conf = rows.map((r) => r.result.answer.confidence!)
    expect(Math.min(...conf)).toBeGreaterThanOrEqual(0.85)
    expect(Math.max(...conf)).toBeLessThanOrEqual(0.98)
    const accuracy = rows.filter((r) => r.result.answer.categoryId === r.item.expected).length / rows.length
    const meanConf = conf.reduce((a, b) => a + b, 0) / conf.length
    expect(meanConf - accuracy).toBeGreaterThan(0.08) // overconfident on average
    expect(rows.every((r) => r.result.answer.probabilities === undefined && r.result.answer.nativeConfidenceKind === 'logprob')).toBe(true)
  })

  it('jev: calibrated probabilities over all categories', () => {
    const rows = simulateAll(new MockEngine('jev', { seed: 3, oracle })).filter((r) => r.result.status === 'ok')
    for (const { result } of rows.slice(0, 300)) {
      const probs = result.answer.probabilities!
      expect(Object.keys(probs).sort()).toEqual(BIG_TASK.categories.map((c) => c.id).sort())
      const sum = Object.values(probs).reduce((a, b) => a + b, 0)
      expect(Math.abs(sum - 1)).toBeLessThan(1e-9)
      const chosen = result.answer.categoryId!
      expect(result.answer.confidence).toBe(probs[chosen])
      expect(Math.max(...Object.values(probs))).toBe(probs[chosen])
      expect(result.answer.nativeConfidenceKind).toBe('jev_confidence')
    }
    const correct = rows.map((r) => (r.result.answer.categoryId === r.item.expected ? 1 : 0))
    const conf = rows.map((r) => r.result.answer.confidence!)
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length
    expect(Math.abs(mean(conf) - mean(correct))).toBeLessThan(0.03)
    // higher confidence → higher accuracy
    const hi = rows.filter((r) => r.result.answer.confidence! >= 0.9)
    const lo = rows.filter((r) => r.result.answer.confidence! < 0.6)
    const acc = (xs: typeof rows) => xs.filter((r) => r.result.answer.categoryId === r.item.expected).length / xs.length
    expect(acc(hi)).toBeGreaterThan(acc(lo) + 0.2)
  })

  it('latency medians ≈ 900 ms (gpt) and ≈ 300 ms (jev)', () => {
    const gpt = simulateAll(new MockEngine('gpt', { seed: 9, oracle })).map((r) => r.result.providerLatencyMs!)
    const jev = simulateAll(new MockEngine('jev', { seed: 9, oracle })).map((r) => r.result.providerLatencyMs!)
    expect(Math.abs(median(gpt) - 900) / 900).toBeLessThan(0.1)
    expect(Math.abs(median(jev) - 300) / 300).toBeLessThan(0.1)
  })
})

describe('MockEngine — unlabeled and abort', () => {
  it('without a label it answers deterministically by hash', () => {
    const engine = new MockEngine('jev', { seed: 5, profile: { transientErrorRate: 0, invalidRate: 0 } })
    const item = { id: 'prueba-rapida', concept: 'Factura de energía eléctrica de marzo' }
    const a = engine.simulate(TASK, item)
    expect(a.status).toBe('ok')
    expect(TASK.categories.map((c) => c.id)).toContain(a.answer.categoryId)
    expect(engine.simulate(TASK, item)).toEqual(a)
  })

  it('waits the simulated latency and never throws on abort', async () => {
    const waited: number[] = []
    const sleep: SleepFn = async (ms) => {
      waited.push(ms)
    }
    const engine = new MockEngine('gpt', { seed: 1, oracle, sleep })
    const result = await engine.classify(BIG_TASK, POOL[0], { signal: new AbortController().signal })
    expect(waited).toEqual([result.providerLatencyMs])

    const slow = new MockEngine('gpt', { seed: 1, oracle })
    const timeout = new AbortController()
    const p1 = slow.classify(BIG_TASK, POOL[0], { signal: timeout.signal })
    timeout.abort(createTimeoutError())
    expect(await p1).toMatchObject({ status: 'timeout', mode: 'mock', answer: { categoryId: null } })

    const cancel = new AbortController()
    const p2 = slow.classify(BIG_TASK, POOL[0], { signal: cancel.signal })
    cancel.abort()
    expect(await p2).toMatchObject({ status: 'error', errorMessage: 'Clasificación cancelada' })
  })
})
