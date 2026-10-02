import { describe, expect, it } from 'vitest'
import { makeRecord } from '../../metrics/__fixtures__/makeRecord.ts'
import {
  buildCategoryIndex,
  categoryText,
  clampConfidence,
  elapsedMs,
  feedWindow,
  globalProgress,
  recordOutcome,
  topProbabilities,
} from './laneView.ts'

describe('recordOutcome', () => {
  it('maps correct / wrong / failed', () => {
    expect(recordOutcome(makeRecord({ expected: 'A', predicted: 'A' }))).toBe('correct')
    expect(recordOutcome(makeRecord({ expected: 'A', predicted: 'B' }))).toBe('wrong')
    expect(recordOutcome(makeRecord({ status: 'invalid' }))).toBe('failed')
    expect(recordOutcome(makeRecord({ status: 'error' }))).toBe('failed')
    expect(recordOutcome(makeRecord({ status: 'timeout' }))).toBe('failed')
  })

  it('does not trust a stale `correct` flag', () => {
    expect(recordOutcome(makeRecord({ expected: 'A', predicted: 'B', correct: true }))).toBe('wrong')
  })
})

describe('categoryText', () => {
  const index = buildCategoryIndex([
    { id: '513530', name: 'Energía eléctrica', description: '' },
    { id: 'X', name: '', description: '' },
  ])

  it('joins id and name, falling back to the id', () => {
    expect(categoryText(index, '513530')).toBe('513530 · Energía eléctrica')
    expect(categoryText(index, 'X')).toBe('X')
    expect(categoryText(index, 'unknown')).toBe('unknown')
  })
})

describe('topProbabilities', () => {
  it('sorts descending, keeps the top n and drops invalid values', () => {
    const top = topProbabilities({ a: 0.1, b: 0.6, c: 0.25, d: 0.05, e: Number.NaN, f: -1, g: 0 }, 3)
    expect(top.map((t) => t.id)).toEqual(['b', 'c', 'a'])
    expect(top[0].p).toBe(0.6)
  })

  it('breaks ties by id and tolerates missing input', () => {
    expect(topProbabilities({ b: 0.5, a: 0.5 }).map((t) => t.id)).toEqual(['a', 'b'])
    expect(topProbabilities(undefined)).toEqual([])
    expect(topProbabilities({ a: 1 }, 0)).toEqual([])
  })
})

describe('clampConfidence', () => {
  it('clamps to [0, 1] and rejects non numbers', () => {
    expect(clampConfidence(0.42)).toBe(0.42)
    expect(clampConfidence(1.7)).toBe(1)
    expect(clampConfidence(-0.2)).toBe(0)
    expect(clampConfidence(undefined)).toBeUndefined()
    expect(clampConfidence(Number.NaN)).toBeUndefined()
  })
})

describe('feedWindow', () => {
  const records = [0, 1, 2, 3, 4].map((index) => makeRecord({ index }))

  it('returns the newest first', () => {
    expect(feedWindow(records, 99).map((r) => r.index)).toEqual([4, 3, 2, 1, 0])
  })

  it('keeps only the latest `limit` and does not mutate the input', () => {
    expect(feedWindow(records, 2).map((r) => r.index)).toEqual([4, 3])
    expect(feedWindow(records, Infinity)).toHaveLength(5)
    expect(feedWindow(records, 0)).toEqual([])
    expect(records.map((r) => r.index)).toEqual([0, 1, 2, 3, 4])
  })
})

describe('elapsedMs', () => {
  it('is null before a start', () => {
    expect(elapsedMs({}, 5000)).toBeNull()
  })

  it('counts up to now while running and freezes at the end', () => {
    expect(elapsedMs({ startedAt: 1000 }, 4500)).toBe(3500)
    expect(elapsedMs({ startedAt: 1000, finishedAt: 2000 }, 9999)).toBe(1000)
  })

  it('never goes negative', () => {
    expect(elapsedMs({ startedAt: 5000 }, 1000)).toBe(0)
  })
})

describe('globalProgress', () => {
  it('adds both lanes', () => {
    expect(globalProgress([{ completed: 3, total: 10 }, { completed: 5, total: 10 }])).toEqual({
      completed: 8,
      total: 20,
      fraction: 0.4,
    })
  })

  it('has no fraction without a plan', () => {
    expect(globalProgress([{ completed: 0, total: 0 }, { completed: 0, total: 0 }]).fraction).toBeNull()
  })

  it('caps the fraction at 1', () => {
    expect(globalProgress([{ completed: 12, total: 10 }]).fraction).toBe(1)
  })
})
