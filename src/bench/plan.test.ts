import { describe, expect, it } from 'vitest'
import { DEFAULT_BENCH_CONFIG, type BenchConfig } from '../shared/contracts.ts'
import { buildRunPlan, selectPlanItems } from './plan.ts'
import { createRng, hashSeed, seededShuffle } from './rng.ts'
import { makeDataset } from './testFixtures.ts'

const config = (patch: Partial<BenchConfig> = {}): BenchConfig => ({ ...DEFAULT_BENCH_CONFIG, datasetId: 'test-ds', ...patch })
const ids = (plan: ReturnType<typeof buildRunPlan>): string[] => plan.map((p) => p.item.id)

describe('rng', () => {
  it('is deterministic per seed and in [0, 1)', () => {
    const a = createRng(7)
    const b = createRng(7)
    const xs = Array.from({ length: 100 }, () => a())
    expect(xs).toEqual(Array.from({ length: 100 }, () => b()))
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true)
    expect(createRng(8)()).not.toBe(xs[0])
  })

  it('hashSeed is stable and order-sensitive', () => {
    expect(hashSeed(42, 'gpt', 'item-1', 0)).toBe(hashSeed(42, 'gpt', 'item-1', 0))
    expect(hashSeed(42, 'gpt', 'item-1', 0)).not.toBe(hashSeed(42, 'jev', 'item-1', 0))
  })

  it('seededShuffle returns a permutation without touching the input', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8]
    const out = seededShuffle(input, createRng(1))
    expect(input).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect([...out].sort()).toEqual(input)
  })
})

describe('buildRunPlan', () => {
  const dataset = makeDataset(30)

  it('is deterministic for a seed and changes with the seed', () => {
    const a = buildRunPlan(dataset, config({ seed: 42 }))
    const b = buildRunPlan(dataset, config({ seed: 42 }))
    expect(a).toEqual(b)
    expect(ids(a)).not.toEqual(ids(buildRunPlan(dataset, config({ seed: 43 }))))
    expect(ids(a)).not.toEqual(dataset.items.map((i) => i.id))
  })

  it('keeps the dataset order without shuffle and does not mutate the dataset', () => {
    const before = dataset.items.map((i) => i.id)
    const plan = buildRunPlan(dataset, config({ shuffle: false }))
    expect(ids(plan)).toEqual(before)
    buildRunPlan(dataset, config({ seed: 1 }))
    expect(dataset.items.map((i) => i.id)).toEqual(before)
  })

  it('filters by difficulty (items without difficulty are left out)', () => {
    const withUnrated = makeDataset(9)
    delete withUnrated.items[0].difficulty
    const plan = buildRunPlan(withUnrated, config({ difficulties: ['easy', 'hard'] }))
    expect(plan.length).toBeGreaterThan(0)
    expect(plan.every((p) => p.item.difficulty === 'easy' || p.item.difficulty === 'hard')).toBe(true)
    expect(ids(plan)).not.toContain('item-0')
    // [] or undefined = all
    expect(buildRunPlan(withUnrated, config({ difficulties: [] }))).toHaveLength(9)
  })

  it('applies the limit after shuffling', () => {
    const full = selectPlanItems(dataset, config({ seed: 5 }))
    const limited = buildRunPlan(dataset, config({ seed: 5, limit: 7 }))
    expect(ids(limited)).toEqual(full.slice(0, 7).map((i) => i.id))
    expect(buildRunPlan(dataset, config({ limit: 1000 }))).toHaveLength(30)
  })

  it('repeats full passes in the same order with a global index', () => {
    const plan = buildRunPlan(makeDataset(4), config({ seed: 3, repetitions: 3 }))
    expect(plan).toHaveLength(12)
    expect(plan.map((p) => p.index)).toEqual(Array.from({ length: 12 }, (_, i) => i))
    expect(plan.map((p) => p.repetition)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2])
    const pass = ids(plan.slice(0, 4))
    expect(ids(plan.slice(4, 8))).toEqual(pass)
    expect(ids(plan.slice(8, 12))).toEqual(pass)
  })
})
