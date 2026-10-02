/**
 * Score pillar: how often the lane picked the expected category.
 *
 * Conventions
 *  - Denominator = completed records (items × repetitions done so far). An invalid / error /
 *    timeout record is a miss: it counts in the expected category's support (a false negative)
 *    and lands in the confusion matrix's "sin respuesta" column.
 *  - Per-category F1 = 2·TP / (support + predicted), which is 0 (not NaN) when either side is 0.
 *  - Macro-F1 averages F1 over the categories present in the EXPECTED labels (support > 0): the
 *    same set for both lanes, so the two macro-F1 are comparable. A prediction towards a category
 *    absent from the run still hurts (recall of the true class) but does not add a row to the mean.
 *  - Weighted-F1 weights each category's F1 by its support.
 */
import { DIFFICULTIES, type Category, type ClassificationRecord, type Difficulty } from '../shared/contracts.ts'
import { isAnswered, isCorrect } from './records.ts'
import { ratio, wilsonInterval, type Interval } from './stats.ts'

/** Most frequent confusion pairs kept in `topConfusions`. */
export const TOP_CONFUSIONS = 10

export interface CategoryScore {
  id: string
  name: string
  group?: string
  /** Records whose expected category is this one. */
  support: number
  /** Answered records that predicted this category. */
  predicted: number
  /** Correct predictions of this category. */
  tp: number
  /** tp / predicted; null when never predicted. */
  precision: number | null
  /** tp / support; null when absent from the expected labels. */
  recall: number | null
  /** 2·tp / (support + predicted); null when the category neither appears nor is predicted. */
  f1: number | null
}

export interface ConfusionMatrix {
  /** Category ids: the task's categories in canonical order, then unknown ids seen in records (sorted). */
  labels: string[]
  names: string[]
  /**
   * matrix[i][j] = records expected `labels[i]` and predicted `labels[j]` (rows = expected,
   * columns = predicted). Each row has `labels.length + 1` cells: the last one
   * (`noAnswerIndex`) counts records without an answer (invalid / error / timeout).
   */
  matrix: number[][]
  noAnswerIndex: number
}

export interface ConfusionPair {
  expected: string
  expectedName: string
  predicted: string
  predictedName: string
  count: number
  /** count / support of the expected category. */
  share: number
  /** Both categories share `Category.group` (null when either has no group). */
  sameGroup: boolean | null
  /** Distinct items behind the pair (drill-down). */
  itemIds: string[]
}

export interface DifficultyScore {
  n: number
  correct: number
  accuracy: number | null
}

export interface ScoreMetrics {
  /** Completed records (denominator of `accuracy`). */
  n: number
  correct: number
  /** correct / completed; invalid / error / timeout count as misses. null without records. */
  accuracy: number | null
  /** Wilson 95 % interval for `accuracy`. */
  accuracyCi: Interval | null
  /** correct / answered (status 'ok'). */
  accuracyOnValid: number | null
  /** Records whose prediction falls in the expected category's group (no answer = miss). */
  groupCorrect: number
  /** Records whose expected category has a group (denominator of `groupAccuracy`). */
  groupTotal: number
  groupAccuracy: number | null
  macroF1: number | null
  weightedF1: number | null
  /** One row per label of the confusion matrix (canonical order). */
  perCategory: CategoryScore[]
  confusion: ConfusionMatrix
  /** Most frequent (expected → predicted) mistakes, answered records only. */
  topConfusions: ConfusionPair[]
  byDifficulty: Record<Difficulty, DifficultyScore>
  /** Records without a difficulty (not in `byDifficulty`). */
  withoutDifficulty: number
}

function cleanGroup(group: string | undefined): string | undefined {
  const g = group?.trim()
  return g ? g : undefined
}

/** Task categories (canonical order, deduplicated) + unknown ids from the records, sorted. */
export function buildLabels(categories: readonly Category[], records: readonly ClassificationRecord[]): string[] {
  const labels: string[] = []
  const seen = new Set<string>()
  for (const c of categories) {
    if (!seen.has(c.id)) {
      seen.add(c.id)
      labels.push(c.id)
    }
  }
  const extras = new Set<string>()
  for (const r of records) {
    if (!seen.has(r.expected)) extras.add(r.expected)
    if (isAnswered(r) && r.predicted !== null && !seen.has(r.predicted)) extras.add(r.predicted)
  }
  return [...labels, ...[...extras].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))]
}

export function computeScore(records: readonly ClassificationRecord[], categories: readonly Category[]): ScoreMetrics {
  const byId = new Map<string, Category>()
  for (const c of categories) if (!byId.has(c.id)) byId.set(c.id, c)
  const nameOf = (id: string) => byId.get(id)?.name ?? id
  const groupOf = (id: string) => cleanGroup(byId.get(id)?.group)

  const labels = buildLabels(categories, records)
  const index = new Map(labels.map((id, i) => [id, i]))
  const L = labels.length
  const matrix = labels.map(() => new Array<number>(L + 1).fill(0))
  const pairItems = new Map<string, Set<string>>()

  const n = records.length
  let correct = 0
  let answered = 0
  let groupCorrect = 0
  let groupTotal = 0
  let withoutDifficulty = 0
  const byDifficulty = {} as Record<Difficulty, DifficultyScore>
  for (const d of DIFFICULTIES) byDifficulty[d] = { n: 0, correct: 0, accuracy: null }

  for (const r of records) {
    const ok = isCorrect(r)
    const hasAnswer = isAnswered(r)
    if (ok) correct += 1
    if (hasAnswer) answered += 1

    const e = index.get(r.expected) as number
    const p = hasAnswer ? (index.get(r.predicted as string) as number) : L
    matrix[e][p] += 1
    if (hasAnswer && p !== e) {
      const key = `${e}|${p}`
      let items = pairItems.get(key)
      if (!items) pairItems.set(key, (items = new Set()))
      items.add(r.itemId)
    }

    // Group accuracy from the task's categories; fall back to the runner's flag for unknown ids.
    const expectedGroup = groupOf(r.expected)
    if (expectedGroup !== undefined) {
      groupTotal += 1
      if (hasAnswer && groupOf(r.predicted as string) === expectedGroup) groupCorrect += 1
    } else if (!byId.has(r.expected) && r.groupCorrect !== undefined) {
      groupTotal += 1
      if (r.groupCorrect && hasAnswer) groupCorrect += 1
    }

    if (r.difficulty !== undefined && byDifficulty[r.difficulty]) {
      const d = byDifficulty[r.difficulty]
      d.n += 1
      if (ok) d.correct += 1
    } else {
      withoutDifficulty += 1
    }
  }
  for (const d of DIFFICULTIES) byDifficulty[d].accuracy = ratio(byDifficulty[d].correct, byDifficulty[d].n)

  const perCategory: CategoryScore[] = labels.map((id, i) => {
    let support = 0
    for (let j = 0; j <= L; j++) support += matrix[i][j]
    let predicted = 0
    for (let k = 0; k < L; k++) predicted += matrix[k][i]
    const tp = matrix[i][i]
    const group = groupOf(id)
    return {
      id,
      name: nameOf(id),
      ...(group !== undefined ? { group } : {}),
      support,
      predicted,
      tp,
      precision: ratio(tp, predicted),
      recall: ratio(tp, support),
      f1: support + predicted > 0 ? (2 * tp) / (support + predicted) : null,
    }
  })

  const present = perCategory.filter((c) => c.support > 0)
  let f1Sum = 0
  let f1Weighted = 0
  for (const c of present) {
    f1Sum += c.f1 as number
    f1Weighted += (c.f1 as number) * c.support
  }

  const topConfusions: ConfusionPair[] = []
  for (let i = 0; i < L; i++) {
    for (let j = 0; j < L; j++) {
      if (i === j || matrix[i][j] === 0) continue
      const ge = groupOf(labels[i])
      const gp = groupOf(labels[j])
      topConfusions.push({
        expected: labels[i],
        expectedName: nameOf(labels[i]),
        predicted: labels[j],
        predictedName: nameOf(labels[j]),
        count: matrix[i][j],
        share: matrix[i][j] / perCategory[i].support,
        sameGroup: ge !== undefined && gp !== undefined ? ge === gp : null,
        itemIds: [...(pairItems.get(`${i}|${j}`) ?? [])],
      })
    }
  }
  // Stable, deterministic order: count desc, then canonical order of expected / predicted.
  topConfusions.sort(
    (a, b) =>
      b.count - a.count ||
      (index.get(a.expected) as number) - (index.get(b.expected) as number) ||
      (index.get(a.predicted) as number) - (index.get(b.predicted) as number),
  )

  return {
    n,
    correct,
    accuracy: ratio(correct, n),
    accuracyCi: wilsonInterval(correct, n),
    accuracyOnValid: ratio(correct, answered),
    groupCorrect,
    groupTotal,
    groupAccuracy: ratio(groupCorrect, groupTotal),
    macroF1: present.length > 0 ? f1Sum / present.length : null,
    weightedF1: n > 0 ? f1Weighted / n : null,
    perCategory,
    confusion: { labels, names: labels.map(nameOf), matrix, noAnswerIndex: L },
    topConfusions: topConfusions.slice(0, TOP_CONFUSIONS),
    byDifficulty,
    withoutDifficulty,
  }
}
