/**
 * Paired comparison of the two lanes on the same slots (itemId + repetition).
 *
 *  - 2×2 table over every matched pair: both right / only GPT / only Jev / both wrong.
 *  - Exact McNemar over those pairs: two-sided binomial test (p = ½) on the discordant pairs
 *    b = only GPT right, c = only Jev right.
 *  - Repetitions of the same item are NOT independent, so the p-value used for significance is an
 *    exact sign test at ITEM level: per item, d = (GPT right − Jev right) summed over its matched
 *    repetitions; items with d > 0 favour GPT, d < 0 favour Jev, d = 0 are ties; binomial test on
 *    the non-tied items. With one repetition per item this is exactly the McNemar test above.
 */
import type { ClassificationRecord, EngineId } from '../shared/contracts.ts'
import { dedupeRecords, isCorrect, slotKey } from './records.ts'
import { binomialTwoSidedP } from './stats.ts'

/** Significance level used for `significant`. */
export const SIGNIFICANCE_ALPHA = 0.05

export interface McNemarResult {
  /** b = only GPT right. */
  gptOnly: number
  /** c = only Jev right. */
  jevOnly: number
  /** b + c. */
  discordant: number
  pValue: number
}

export interface ItemSignTest {
  /** Items with at least one matched pair. */
  items: number
  gptBetter: number
  jevBetter: number
  ties: number
  pValue: number
}

export interface PairedTest {
  /** Matched slots (same itemId + repetition in both lanes). */
  pairs: number
  bothCorrect: number
  gptOnly: number
  jevOnly: number
  bothWrong: number
  /** Records with no counterpart in the other lane. */
  unmatchedGpt: number
  unmatchedJev: number
  /** Matched pairs whose expected label differs between lanes (different datasets?). */
  labelMismatches: number
  /** Distinct repetitions among the pairs. */
  repetitions: number
  /** Exact McNemar over every pair (assumes independent pairs). */
  mcnemar: McNemarResult
  /** Exact sign test with items as the independent unit (equals McNemar with 1 repetition). */
  itemTest: ItemSignTest
  /** p-value used for significance: `itemTest.pValue`. 1 without pairs. */
  pValue: number
  significant: boolean
  /** Lane with more discordant wins at pair level ('tie' if equal, null without pairs). */
  favored: EngineId | 'tie' | null
  /** Human-readable name of the test behind `pValue`. */
  testName: string
}

export function pairedTest(gpt: readonly ClassificationRecord[], jev: readonly ClassificationRecord[]): PairedTest {
  const g = new Map(dedupeRecords(gpt).records.map((r) => [slotKey(r), r]))
  const j = new Map(dedupeRecords(jev).records.map((r) => [slotKey(r), r]))

  let pairs = 0
  let bothCorrect = 0
  let gptOnly = 0
  let jevOnly = 0
  let bothWrong = 0
  let labelMismatches = 0
  const reps = new Set<number>()
  const perItem = new Map<string, number>()

  for (const [key, gr] of g) {
    const jr = j.get(key)
    if (!jr) continue
    pairs += 1
    reps.add(gr.repetition)
    if (gr.expected !== jr.expected) labelMismatches += 1
    const gc = isCorrect(gr)
    const jc = isCorrect(jr)
    if (gc && jc) bothCorrect += 1
    else if (gc) gptOnly += 1
    else if (jc) jevOnly += 1
    else bothWrong += 1
    perItem.set(gr.itemId, (perItem.get(gr.itemId) ?? 0) + (gc ? 1 : 0) - (jc ? 1 : 0))
  }

  let gptBetter = 0
  let jevBetter = 0
  let ties = 0
  for (const d of perItem.values()) {
    if (d > 0) gptBetter += 1
    else if (d < 0) jevBetter += 1
    else ties += 1
  }

  const itemP = binomialTwoSidedP(gptBetter, gptBetter + jevBetter)
  const repetitions = reps.size
  return {
    pairs,
    bothCorrect,
    gptOnly,
    jevOnly,
    bothWrong,
    unmatchedGpt: g.size - pairs,
    unmatchedJev: j.size - pairs,
    labelMismatches,
    repetitions,
    mcnemar: { gptOnly, jevOnly, discordant: gptOnly + jevOnly, pValue: binomialTwoSidedP(gptOnly, gptOnly + jevOnly) },
    itemTest: { items: perItem.size, gptBetter, jevBetter, ties, pValue: itemP },
    pValue: itemP,
    significant: pairs > 0 && itemP < SIGNIFICANCE_ALPHA,
    favored: pairs === 0 ? null : gptOnly > jevOnly ? 'gpt' : jevOnly > gptOnly ? 'jev' : 'tie',
    testName: repetitions > 1 ? 'prueba de signos exacta por concepto' : 'McNemar exacta',
  }
}
