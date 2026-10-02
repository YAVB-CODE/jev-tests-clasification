/**
 * Per-concept table, GPT and Jev side by side: filters (with counters), text search, sorting,
 * repetition selector and expandable rows. The table scrolls inside its own container.
 */
import clsx from 'clsx'
import { Fragment, useDeferredValue, useMemo, useState } from 'react'
import { useBench, type BenchRun } from '../../bench/useBench.ts'
import { ENGINE_IDS, type ClassificationRecord, type EngineId } from '../../shared/contracts.ts'
import { int, ms, pct } from '../../metrics/format.ts'
import { ENGINE_THEME, UI } from '../ui/theme.ts'
import {
  ROW_FILTERS,
  SORT_OPTIONS,
  STATUS_LABELS,
  buildDetailRows,
  categoryNames,
  countFilters,
  defaultDescending,
  matchesFilter,
  matchesQuery,
  outcomeOf,
  repetitionsOf,
  sortRows,
  type DetailRow,
  type RowFilter,
  type SortKey,
} from './detailRows.ts'
import { CategoryLabel, DifficultyBadge, OutcomeIcon } from './parts.tsx'
import RowDetail from './RowDetail.tsx'

/** Concept, expected, difficulty + 3 columns per engine. */
const COLUMN_COUNT = 9

function HeadCell({ children, engine, right, srPrefix }: { children: string; engine?: EngineId; right?: boolean; srPrefix?: string }) {
  // The opaque base keeps scrolled rows from showing through the translucent engine tint.
  return (
    <th scope="col" className="sticky top-0 z-10 bg-white p-0 font-medium dark:bg-zinc-900">
      <div
        className={clsx(
          'border-b border-zinc-200 px-2.5 py-2 text-xs font-medium tracking-wide whitespace-nowrap uppercase dark:border-zinc-800',
          right ? 'text-right' : 'text-left',
          engine ? [ENGINE_THEME[engine].soft, ENGINE_THEME[engine].text] : UI.muted,
        )}
      >
        {srPrefix ? <span className="sr-only">{srPrefix} </span> : null}
        {children}
      </div>
    </th>
  )
}

function PredictionCell({ record, names }: { record: ClassificationRecord | undefined; names: ReadonlyMap<string, string> }) {
  const outcome = outcomeOf(record)
  return (
    <div className="flex items-start gap-2">
      <OutcomeIcon outcome={outcome} className="mt-0.5" />
      <div className="min-w-0">
        {!record ? (
          <span className={clsx(UI.muted, 'text-sm')}>Pendiente</span>
        ) : outcome === 'failed' ? (
          <span className="text-sm font-medium" title={record.errorMessage}>
            {STATUS_LABELS[record.status]}
          </span>
        ) : (
          <CategoryLabel id={record.predicted ?? '—'} name={record.predicted ? names.get(record.predicted) : undefined} />
        )}
      </div>
    </div>
  )
}

interface ConceptRowProps {
  row: DetailRow
  expanded: boolean
  showRepetition: boolean
  names: ReadonlyMap<string, string>
  onToggle: (key: string) => void
}

function ConceptRow({ row, expanded, showRepetition, names, onToggle }: ConceptRowProps) {
  const { item } = row
  const detailId = `detail-${row.key}`
  const meta = [item.supplier, item.amount !== undefined ? `${int(item.amount)}${item.currency ? ` ${item.currency}` : ''}` : null]
    .filter(Boolean)
    .join(' · ')
  return (
    <Fragment>
      <tr className={clsx('align-top', expanded && 'bg-zinc-50 dark:bg-zinc-800/40')}>
        <td className="px-2.5 py-2">
          <button
            type="button"
            onClick={() => onToggle(row.key)}
            aria-expanded={expanded}
            aria-controls={expanded ? detailId : undefined}
            className="flex w-full min-w-48 items-start gap-2 rounded text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500"
          >
            <span aria-hidden="true" className="mt-0.5 w-3 shrink-0 text-xs text-zinc-500">
              {expanded ? '▾' : '▸'}
            </span>
            <span className="min-w-0">
              <span className="block text-sm break-words">
                <span className={clsx(UI.muted, 'mr-1.5 text-xs tabular-nums')}>#{row.index + 1}</span>
                {item.concept}
                {showRepetition ? <span className={clsx(UI.badge, 'ml-1.5 bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400')}>rep. {row.repetition + 1}</span> : null}
              </span>
              {meta ? <span className={clsx(UI.muted, 'block text-xs break-words')}>{meta}</span> : null}
            </span>
          </button>
        </td>
        <td className="px-2.5 py-2">
          <div className="min-w-32">
            <CategoryLabel id={item.expected} name={names.get(item.expected)} />
          </div>
        </td>
        <td className="px-2.5 py-2 whitespace-nowrap">
          <DifficultyBadge difficulty={item.difficulty} />
        </td>
        {ENGINE_IDS.map((e) => {
          const record = row.records[e]
          const border = clsx('border-l px-2.5 py-2', ENGINE_THEME[e].border)
          return (
            <Fragment key={e}>
              <td className={border}>
                <div className="min-w-36">
                  <PredictionCell record={record} names={names} />
                </div>
              </td>
              <td className="px-2.5 py-2 text-right text-sm whitespace-nowrap tabular-nums">
                {record?.confidence !== undefined ? pct(record.confidence, 0) : '—'}
              </td>
              <td className="px-2.5 py-2 text-right text-sm whitespace-nowrap tabular-nums">{record ? ms(record.latencyMs) : '—'}</td>
            </Fragment>
          )
        })}
      </tr>
      {expanded ? (
        <tr id={detailId} className="bg-zinc-50/70 dark:bg-zinc-950/40">
          <td colSpan={COLUMN_COUNT} className="p-0">
            {/* Pinned to the visible width of the scroll container, so it stays on screen on narrow viewports. */}
            <div className="sticky left-0 box-border w-[100cqw] p-4">
              <RowDetail row={row} names={names} />
            </div>
          </td>
        </tr>
      ) : null}
    </Fragment>
  )
}

const CHIP_BASE =
  'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500'

export default function ConceptsTable({ run }: { run: BenchRun }) {
  const gptRecords = useBench((s) => s.lanes.gpt.records)
  const jevRecords = useBench((s) => s.lanes.jev.records)

  const [filter, setFilter] = useState<RowFilter>('all')
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('queue')
  const [descending, setDescending] = useState(defaultDescending('queue'))
  const [repetition, setRepetition] = useState<number | 'all'>('all')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())

  const deferredQuery = useDeferredValue(query)
  const names = useMemo(() => categoryNames(run.task.categories), [run.task])
  const rows = useMemo(() => buildDetailRows(run.plan, { gpt: gptRecords, jev: jevRecords }), [run.plan, gptRecords, jevRecords])
  const repetitions = useMemo(() => repetitionsOf(rows), [rows])
  const activeRepetition = repetition !== 'all' && repetitions.includes(repetition) ? repetition : 'all'

  // Counters reflect the repetition and the search, so each chip shows what it would list.
  const scoped = useMemo(
    () => rows.filter((r) => (activeRepetition === 'all' || r.repetition === activeRepetition) && matchesQuery(r, deferredQuery, names)),
    [rows, activeRepetition, deferredQuery, names],
  )
  const counts = useMemo(() => countFilters(scoped), [scoped])
  const visible = useMemo(
    () => sortRows(scoped.filter((r) => matchesFilter(r, filter)), sortKey, descending),
    [scoped, filter, sortKey, descending],
  )

  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  const filtering = filter !== 'all' || query.trim() !== '' || activeRepetition !== 'all'
  const clearFilters = () => {
    setFilter('all')
    setQuery('')
    setRepetition('all')
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="min-w-0 grow basis-60 sm:max-w-sm">
          <label htmlFor="detail-search" className={clsx(UI.label, 'mb-1 block')}>
            Buscar
          </label>
          <input
            id="detail-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Concepto, proveedor o categoría…"
            className={clsx(UI.input, 'w-full')}
          />
        </div>
        <div>
          <label htmlFor="detail-sort" className={clsx(UI.label, 'mb-1 block')}>
            Ordenar por
          </label>
          <div className="flex gap-1.5">
            <select
              id="detail-sort"
              value={sortKey}
              onChange={(e) => {
                const key = e.target.value as SortKey
                setSortKey(key)
                setDescending(defaultDescending(key))
              }}
              className={UI.input}
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <button type="button" onClick={() => setDescending((d) => !d)} className={clsx(UI.button, 'px-2 py-1')} title="Invertir el orden">
              {descending ? '↓ Descendente' : '↑ Ascendente'}
            </button>
          </div>
        </div>
        {repetitions.length > 1 ? (
          <div>
            <label htmlFor="detail-repetition" className={clsx(UI.label, 'mb-1 block')}>
              Repetición
            </label>
            <select
              id="detail-repetition"
              value={String(activeRepetition)}
              onChange={(e) => setRepetition(e.target.value === 'all' ? 'all' : Number(e.target.value))}
              className={UI.input}
            >
              <option value="all">Todas</option>
              {repetitions.map((r) => (
                <option key={r} value={r}>
                  Repetición {r + 1}
                </option>
              ))}
            </select>
          </div>
        ) : null}
      </div>

      <div role="group" aria-label="Filtrar conceptos" className="flex flex-wrap gap-1.5">
        {ROW_FILTERS.map((f) => {
          const active = filter === f.id
          return (
            <button
              key={f.id}
              type="button"
              aria-pressed={active}
              title={f.hint}
              onClick={() => setFilter(f.id)}
              className={clsx(
                CHIP_BASE,
                active
                  ? 'border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                  : 'border-zinc-300 bg-white hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:bg-zinc-800',
                !active && counts[f.id] === 0 && 'opacity-60',
              )}
            >
              {f.label}
              <span className="text-xs font-semibold tabular-nums">{counts[f.id]}</span>
            </button>
          )
        })}
      </div>

      <p className={clsx(UI.muted, 'text-sm')} aria-live="polite">
        Mostrando {visible.length} de {rows.length} {rows.length === 1 ? 'clasificación' : 'clasificaciones'}
        {filtering ? ' con los filtros actuales' : ''}.
        {filtering ? (
          <button type="button" onClick={clearFilters} className="ml-2 underline underline-offset-2 hover:no-underline">
            Limpiar filtros
          </button>
        ) : null}
      </p>

      {visible.length === 0 ? (
        <p className={clsx(UI.card, UI.cardPadding, UI.muted, 'text-sm')}>
          {rows.length === 0 ? 'La corrida no tiene conceptos.' : 'Ningún concepto coincide con los filtros.'}
        </p>
      ) : (
        <div className={clsx(UI.card, '@container relative max-h-[75vh] overflow-auto')}>
          <table className="w-full text-left">
            <thead>
              <tr>
                <HeadCell>Concepto</HeadCell>
                <HeadCell>Esperado</HeadCell>
                <HeadCell>Dificultad</HeadCell>
                {ENGINE_IDS.map((e) => (
                  <Fragment key={e}>
                    <HeadCell engine={e}>{`${ENGINE_THEME[e].label} · predicho`}</HeadCell>
                    <HeadCell engine={e} right srPrefix={ENGINE_THEME[e].label}>
                      Conf.
                    </HeadCell>
                    <HeadCell engine={e} right srPrefix={ENGINE_THEME[e].label}>
                      Latencia
                    </HeadCell>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {visible.map((row) => (
                <ConceptRow
                  key={row.key}
                  row={row}
                  expanded={expanded.has(row.key)}
                  showRepetition={repetitions.length > 1}
                  names={names}
                  onToggle={toggle}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
