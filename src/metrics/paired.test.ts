import { describe, expect, it } from 'vitest'
import type { ClassificationRecord, EngineId } from '../shared/contracts.ts'
import { makeRecord } from './__fixtures__/makeRecord.ts'
import { pairedTest } from './paired.ts'

/** Build both lanes from a list of (gptRight, jevRight) per item. */
function lanes(outcomes: readonly [boolean, boolean][], repetition = 0) {
  const mk = (engine: EngineId, ok: boolean, i: number): ClassificationRecord =>
    makeRecord({ engine, index: i, repetition, expected: 'A', predicted: ok ? 'A' : 'B' })
  return {
    gpt: outcomes.map(([g], i) => mk('gpt', g, i)),
    jev: outcomes.map(([, j], i) => mk('jev', j, i)),
  }
}

function table(bothRight: number, gptOnly: number, jevOnly: number, bothWrong: number): [boolean, boolean][] {
  return [
    ...Array.from({ length: bothRight }, (): [boolean, boolean] => [true, true]),
    ...Array.from({ length: gptOnly }, (): [boolean, boolean] => [true, false]),
    ...Array.from({ length: jevOnly }, (): [boolean, boolean] => [false, true]),
    ...Array.from({ length: bothWrong }, (): [boolean, boolean] => [false, false]),
  ]
}

describe('pairedTest — 2×2 table and exact McNemar', () => {
  it('b = 10, c = 2 → p ≈ 0.0386 (hand-computed 158/4096)', () => {
    const { gpt, jev } = lanes(table(30, 10, 2, 8))
    const t = pairedTest(gpt, jev)
    expect(t).toMatchObject({ pairs: 50, bothCorrect: 30, gptOnly: 10, jevOnly: 2, bothWrong: 8 })
    expect(t.mcnemar.discordant).toBe(12)
    expect(t.mcnemar.pValue).toBeCloseTo(158 / 4096, 12)
    expect(t.pValue).toBeCloseTo(0.0386, 4)
    expect(t.significant).toBe(true)
    expect(t.favored).toBe('gpt')
    expect(t.repetitions).toBe(1)
    expect(t.testName).toBe('McNemar exacta')
    // one repetition: the item-level sign test IS McNemar
    expect(t.itemTest).toMatchObject({ items: 50, gptBetter: 10, jevBetter: 2, ties: 38 })
    expect(t.itemTest.pValue).toBe(t.mcnemar.pValue)
  })

  it('is not significant for a small, balanced difference', () => {
    const { gpt, jev } = lanes(table(40, 3, 1, 6))
    const t = pairedTest(gpt, jev)
    expect(t.pValue).toBeCloseTo(0.625, 12) // 2 · (1 + 4) / 16
    expect(t.significant).toBe(false)
  })

  it('favours Jev symmetrically and ties on equal discordants', () => {
    const jevWins = lanes(table(0, 2, 10, 0))
    expect(pairedTest(jevWins.gpt, jevWins.jev)).toMatchObject({ favored: 'jev', significant: true })
    const even = lanes(table(5, 3, 3, 1))
    expect(pairedTest(even.gpt, even.jev)).toMatchObject({ favored: 'tie', pValue: 1, significant: false })
  })

  it('treats invalid / timeout as wrong', () => {
    const gpt = [makeRecord({ engine: 'gpt', index: 0, status: 'timeout' })]
    const jev = [makeRecord({ engine: 'jev', index: 0, predicted: 'A' })]
    expect(pairedTest(gpt, jev)).toMatchObject({ pairs: 1, jevOnly: 1, gptOnly: 0 })
  })
})

describe('pairedTest — matching', () => {
  it('pairs by itemId + repetition and reports unmatched records', () => {
    const { gpt, jev } = lanes(table(5, 0, 0, 0))
    const t = pairedTest(gpt, jev.slice(0, 3))
    expect(t.pairs).toBe(3)
    expect(t.unmatchedGpt).toBe(2)
    expect(t.unmatchedJev).toBe(0)
  })

  it('without pairs: p = 1, not significant, favored null', () => {
    const t = pairedTest([], [])
    expect(t).toMatchObject({ pairs: 0, pValue: 1, significant: false, favored: null })
  })

  it('counts label mismatches between lanes', () => {
    const gpt = [makeRecord({ engine: 'gpt', index: 0, expected: 'A' })]
    const jev = [makeRecord({ engine: 'jev', index: 0, expected: 'B' })]
    expect(pairedTest(gpt, jev).labelMismatches).toBe(1)
  })
})

describe('pairedTest — repetitions', () => {
  it('uses items as the independent unit when items repeat', () => {
    // 3 items × 3 repetitions; GPT right everywhere, Jev wrong on item 0 and right on 1–2.
    const gpt: ClassificationRecord[] = []
    const jev: ClassificationRecord[] = []
    for (let rep = 0; rep < 3; rep++) {
      for (let i = 0; i < 3; i++) {
        gpt.push(makeRecord({ engine: 'gpt', index: i, repetition: rep, predicted: 'A' }))
        jev.push(makeRecord({ engine: 'jev', index: i, repetition: rep, predicted: i === 0 ? 'B' : 'A' }))
      }
    }
    const t = pairedTest(gpt, jev)
    expect(t.pairs).toBe(9)
    expect(t.repetitions).toBe(3)
    expect(t.gptOnly).toBe(3)
    expect(t.mcnemar.pValue).toBeCloseTo(0.25, 12) // pair-level (optimistic): 2 · 1/8
    expect(t.itemTest).toMatchObject({ items: 3, gptBetter: 1, jevBetter: 0, ties: 2 })
    expect(t.pValue).toBe(1) // one item is no evidence
    expect(t.testName).toBe('prueba de signos exacta por concepto')
  })
})
