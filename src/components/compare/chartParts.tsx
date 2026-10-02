/** Building blocks shared by the four comparison charts: markers, legend, tooltip box and the card frame. */
import clsx from 'clsx'
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import type { EngineId } from '../../shared/contracts.ts'
import { DASH } from '../../metrics/index.ts'
import { UI } from '../ui/theme.ts'
import { SECTION_CARD, SERIES_COLOR, SURFACE_COLOR } from './compareTheme.ts'

// ─────────────────────────────── Markers ───────────────────────────────

/** Diamond with the same area as a circle of radius `r`. */
function diamondPoints(cx: number, cy: number, r: number): string {
  const d = r * Math.sqrt(Math.PI / 2)
  return `${cx},${cy - d} ${cx + d},${cy} ${cx},${cy + d} ${cx - d},${cy}`
}

/**
 * Mark of an engine inside a chart: circle for GPT, diamond for Jev (secondary encoding next to
 * color), with a 2px ring in the surface color and a transparent hit area of at least 24px.
 */
export function MarkerShape({
  engine,
  cx,
  cy,
  r,
  opacity = 1,
  hit = true,
}: {
  engine: EngineId
  cx: number
  cy: number
  r: number
  opacity?: number
  hit?: boolean
}) {
  const color = SERIES_COLOR[engine]
  return (
    <g>
      {hit && <circle cx={cx} cy={cy} r={Math.max(r + 4, 12)} fill="transparent" />}
      {engine === 'gpt' ? (
        <circle cx={cx} cy={cy} r={r} fill={color} fillOpacity={opacity} stroke={SURFACE_COLOR} strokeWidth={2} />
      ) : (
        <polygon
          points={diamondPoints(cx, cy, r)}
          fill={color}
          fillOpacity={opacity}
          stroke={SURFACE_COLOR}
          strokeWidth={2}
          strokeLinejoin="round"
        />
      )}
    </g>
  )
}

// ─────────────────────────────── Legend ───────────────────────────────

export interface LegendItem {
  engine: EngineId
  label: string
  /** How the series is drawn: filled swatch (bars), marker (bubbles) or line + marker. */
  kind: 'bar' | 'marker' | 'line'
  /** Secondary text after the label (e.g. a key value). */
  note?: string
}

function LegendKey({ engine, kind }: Pick<LegendItem, 'engine' | 'kind'>) {
  const color = SERIES_COLOR[engine]
  if (kind === 'bar') return <span aria-hidden className="size-2.5 rounded-sm" style={{ background: color }} />
  return (
    <svg aria-hidden width="20" height="12" viewBox="0 0 20 12" className="shrink-0">
      {kind === 'line' && <line x1="0" y1="6" x2="20" y2="6" stroke={color} strokeWidth="2" strokeLinecap="round" />}
      <MarkerShape engine={engine} cx={10} cy={6} r={3.5} hit={false} />
    </svg>
  )
}

/** Legend for two series: always present, text in ink tokens, identity from the key beside it. */
export function ChartLegend({ items }: { items: LegendItem[] }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {items.map((it) => (
        <li key={it.engine} className="flex items-center gap-1.5 text-xs text-zinc-600 dark:text-zinc-300">
          <LegendKey engine={it.engine} kind={it.kind} />
          <span className="font-medium text-zinc-900 dark:text-zinc-100">{it.label}</span>
          {it.note && <span className="tabular-nums">{it.note}</span>}
        </li>
      ))}
    </ul>
  )
}

// ─────────────────────────────── Tooltip ───────────────────────────────

export interface TooltipRow {
  engine: EngineId
  label: string
  value: string
}

/** Values lead (strong), series names follow (secondary); rows are keyed with the series mark. */
export function TooltipBox({ title, rows, footer }: { title?: ReactNode; rows: TooltipRow[]; footer?: ReactNode }) {
  return (
    <div className="pointer-events-none min-w-40 rounded-lg border border-zinc-200 bg-white px-2.5 py-2 text-xs shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
      {title && <div className="mb-1.5 font-medium text-zinc-500 dark:text-zinc-400">{title}</div>}
      <ul className="space-y-1">
        {rows.map((r) => (
          <li key={r.engine} className="flex items-center gap-2">
            <svg aria-hidden width="12" height="12" viewBox="0 0 12 12" className="shrink-0">
              <MarkerShape engine={r.engine} cx={6} cy={6} r={3.5} hit={false} />
            </svg>
            <span className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">{r.value}</span>
            <span className="text-zinc-500 dark:text-zinc-400">{r.label}</span>
          </li>
        ))}
      </ul>
      {footer && <div className="mt-1.5 border-t border-zinc-200 pt-1.5 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">{footer}</div>}
    </div>
  )
}

// ─────────────────────────────── Card ───────────────────────────────

export interface ChartTable {
  head: string[]
  rows: (string | number | null)[][]
}

/**
 * Chart frame: title, "how to read" subtitle, legend, the chart (or an empty state) and a table twin.
 * The table is always in the DOM (screen-reader only while the chart is shown) so every value is
 * reachable without the tooltip; the button swaps chart and table for everyone.
 */
export function ChartCard({
  title,
  subtitle,
  legend,
  empty,
  emptyText,
  table,
  summary,
  footnote,
  className,
  children,
}: {
  title: string
  subtitle: string
  legend: ReactNode
  empty: boolean
  emptyText: string
  table: ChartTable
  /** Short text description of the chart for assistive tech. */
  summary: string
  footnote?: ReactNode
  className?: string
  children: ReactNode
}) {
  const [showTable, setShowTable] = useState(false)
  const titleId = useId()
  const tableShown = showTable && !empty
  return (
    <section aria-labelledby={titleId} className={clsx(SECTION_CARD, 'flex min-w-0 flex-col', className)}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 id={titleId} className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {title}
          </h4>
          <p className={clsx('mt-0.5 text-xs leading-snug', UI.muted)}>{subtitle}</p>
        </div>
        {!empty && (
          <button
            type="button"
            aria-pressed={showTable}
            onClick={() => setShowTable((v) => !v)}
            className="shrink-0 rounded-md border border-zinc-300 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {showTable ? 'Ver gráfica' : 'Ver tabla'}
          </button>
        )}
      </header>
      <div className="mt-2">{legend}</div>
      <div className="mt-2 min-h-0 flex-1">
        {empty ? (
          <p className="grid h-56 place-items-center rounded-lg bg-zinc-50 px-6 text-center text-sm text-zinc-500 dark:bg-zinc-950/50 dark:text-zinc-400">
            {emptyText}
          </p>
        ) : (
          <>
            <div role="img" aria-label={summary} className={clsx('h-64 sm:h-72', tableShown && 'hidden')}>
              {children}
            </div>
            <div className={clsx(!tableShown && 'sr-only', tableShown && 'relative max-h-72 overflow-auto')}>
              <table className="w-full border-collapse text-xs">
                <caption className="sr-only">{`Datos de «${title}»`}</caption>
                <thead>
                  <tr className="border-b border-zinc-200 text-zinc-500 dark:border-zinc-700 dark:text-zinc-400">
                    {table.head.map((h, i) => (
                      <th key={h} scope="col" className={clsx('px-2 py-1.5 font-medium', i === 0 ? 'text-left' : 'text-right')}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((r, ri) => (
                    <tr key={ri} className="border-b border-zinc-100 last:border-b-0 dark:border-zinc-800">
                      {r.map((c, ci) =>
                        ci === 0 ? (
                          <th key={ci} scope="row" className="px-2 py-1.5 text-left font-medium text-zinc-900 dark:text-zinc-100">
                            {c ?? DASH}
                          </th>
                        ) : (
                          <td key={ci} className="px-2 py-1.5 text-right tabular-nums text-zinc-600 dark:text-zinc-300">
                            {c ?? DASH}
                          </td>
                        ),
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      {footnote && !tableShown && <div className={clsx('mt-2 space-y-0.5 text-xs', UI.muted)}>{footnote}</div>}
    </section>
  )
}
