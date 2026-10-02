import clsx from 'clsx'
import { memo, useCallback, useMemo, useState } from 'react'
import { fixed, ms, pct } from '../../metrics/index.ts'
import { recordKey, type ClassificationRecord, type LabeledConcept } from '../../shared/contracts.ts'
import { OUTCOME_STYLE } from '../ui/theme.ts'
import { FeedDetail } from './FeedDetail.tsx'
import { NO_ANSWER_TEXT, categoryText, clampConfidence, feedWindow, recordOutcome, type CategoryIndex, type Outcome } from './laneView.ts'

/** Rows rendered by default; older ones stay one click away. */
const FEED_LIMIT = 100

const BAR_FILL: Record<Outcome, string> = {
  correct: 'bg-green-500',
  wrong: 'bg-rose-500',
  failed: 'bg-amber-500',
}

function ConfidenceBar({ value, outcome }: { value: number | undefined; outcome: Outcome }) {
  if (value === undefined) {
    return <span className="w-24 shrink-0 text-right text-[11px] whitespace-nowrap text-zinc-400 dark:text-zinc-500">sin confianza</span>
  }
  return (
    <span className="flex w-24 shrink-0 items-center gap-1.5" title={`Confianza declarada: ${pct(value, 1)}`}>
      <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <span className={clsx('block h-full rounded-full', BAR_FILL[outcome])} style={{ width: `${fixed(value * 100, 0)}%` }} />
      </span>
      <span className="w-9 shrink-0 text-right text-[11px] whitespace-nowrap text-zinc-600 tabular-nums dark:text-zinc-300">{fixed(value * 100, 0)} %</span>
    </span>
  )
}

interface FeedRowProps {
  record: ClassificationRecord
  item: LabeledConcept | undefined
  categories: CategoryIndex
  open: boolean
  onToggle: (key: string) => void
}

const FeedRow = memo(function FeedRow({ record, item, categories, open, onToggle }: FeedRowProps) {
  const key = recordKey(record)
  const detailId = `feed-detail-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`
  const outcome = recordOutcome(record)
  const style = OUTCOME_STYLE[outcome]
  const concept = item?.concept ?? record.itemId
  const predicted = record.predicted !== null ? categoryText(categories, record.predicted) : NO_ANSWER_TEXT[record.status]
  const expected = categoryText(categories, record.expected)

  return (
    <li className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        onClick={() => onToggle(key)}
        className={clsx(
          'grid w-full grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-2 px-2.5 py-1.5 text-left hover:bg-zinc-50 focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-sky-500 dark:hover:bg-zinc-800/60',
          open && 'bg-zinc-50 dark:bg-zinc-800/40',
        )}
      >
        <span
          role="img"
          aria-label={style.label}
          title={style.label}
          className={clsx('mt-px flex size-5 items-center justify-center rounded text-xs leading-none font-bold', style.text, style.soft)}
        >
          {style.icon}
        </span>
        <span className="min-w-0">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px]" title={concept}>
              {concept}
            </span>
            <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums dark:text-zinc-400" title="Latencia de extremo a extremo">
              {ms(record.latencyMs)}
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
            <span className="min-w-0 flex-1 truncate" title={`Predicho: ${predicted}`}>
              <span className="text-zinc-400 dark:text-zinc-500">pred.</span> <span className={style.text}>{predicted}</span>
            </span>
            <span className="max-w-[35%] shrink-0 truncate tabular-nums" title={`Esperado: ${expected}`}>
              esp. {record.expected}
            </span>
            <ConfidenceBar value={clampConfidence(record.confidence)} outcome={outcome} />
          </span>
        </span>
      </button>
      {open && <FeedDetail id={detailId} record={record} item={item} categories={categories} />}
    </li>
  )
})

/** Live feed of one lane: newest first, internal scroll, fixed height (identical in both lanes). */
export function LaneFeed({
  records,
  items,
  categories,
}: {
  records: readonly ClassificationRecord[]
  items: ReadonlyMap<string, LabeledConcept>
  categories: CategoryIndex
}) {
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const rows = useMemo(() => feedWindow(records, showAll ? Infinity : FEED_LIMIT), [records, showAll])
  const onToggle = useCallback((key: string) => setOpenKey((prev) => (prev === key ? null : key)), [])
  const hidden = records.length - rows.length

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs">
        <h3 className="font-semibold">Feed en vivo</h3>
        <span className="text-zinc-500 tabular-nums dark:text-zinc-400">
          {records.length === 0 ? 'sin clasificaciones' : `${records.length} clasificaci${records.length === 1 ? 'ón' : 'ones'}`}
          {hidden > 0 && (
            <>
              {' · '}
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="underline underline-offset-2 hover:text-zinc-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-500 dark:hover:text-zinc-100"
              >
                ver las {hidden} anteriores
              </button>
            </>
          )}
        </span>
      </div>
      <div
        className="relative h-80 overflow-y-auto overscroll-contain rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900"
        tabIndex={0}
        role="region"
        aria-label="Feed de clasificaciones, la más reciente arriba"
      >
        {rows.length === 0 ? (
          <p className="flex h-full items-center justify-center px-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
            Aquí aparecerá cada clasificación a medida que llegue. Pulsa Iniciar para correr el benchmark.
          </p>
        ) : (
          <ul>
            {rows.map((record) => (
              <FeedRow
                key={recordKey(record)}
                record={record}
                item={items.get(record.itemId)}
                categories={categories}
                open={openKey === recordKey(record)}
                onToggle={onToggle}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
