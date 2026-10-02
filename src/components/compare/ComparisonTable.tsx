/**
 * Comparison table grouped by pillar (+ informative cost): metric with a one-line explanation, GPT,
 * Jev, Δ (the winner's advantage) and winner. Primary rows (they decide the verdict) are
 * highlighted; informative rows are dimmed.
 */
import clsx from 'clsx'
import { useId, useState } from 'react'
import { PILLARS, formatRowValue } from '../../metrics/index.ts'
import type { Comparison, ComparisonRow, Pillar } from '../../metrics/index.ts'
import { ENGINE_IDS } from '../../shared/contracts.ts'
import { ENGINE_THEME, UI } from '../ui/theme.ts'
import { SECTION_CARD, SECTION_LEAD, SECTION_TITLE } from './compareTheme.ts'
import { directionLabel, groupRows, helpLine, isEngineWinner, winnerLabel } from './panelData.ts'
import type { RowGroup } from './panelData.ts'
import { BestMark, WinnerChip } from './panelParts.tsx'

const isVerdictPillar = (p: string): p is Pillar => (PILLARS as readonly string[]).includes(p)

function RowTag({ row }: { row: ComparisonRow }) {
  if (row.primary) {
    return (
      <span className="rounded bg-zinc-900 px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-white dark:bg-zinc-100 dark:text-zinc-900">
        Decide
      </span>
    )
  }
  if (row.informative || row.pillar === 'cost') {
    return <span className="rounded border border-zinc-300 px-1.5 py-px text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:border-zinc-600 dark:text-zinc-400">Informativo</span>
  }
  return null
}

function MetricCell({ row, showHelp }: { row: ComparisonRow; showHelp: boolean }) {
  return (
    <th
      scope="row"
      className={clsx('border-l-4 px-1.5 py-2 sm:px-3 text-left align-top font-normal', row.primary ? 'border-l-zinc-800 dark:border-l-zinc-200' : 'border-l-transparent')}
      title={row.hint}
    >
      <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className={clsx(row.primary ? 'font-semibold text-zinc-900 dark:text-zinc-50' : row.informative ? UI.muted : 'text-zinc-800 dark:text-zinc-200')}>
          {row.label}
        </span>
        <RowTag row={row} />
        {!row.shared && <span className={clsx('text-[11px]', UI.muted)}>· {directionLabel(row.better)}</span>}
      </span>
      {showHelp && row.hint && <span className={clsx('mt-0.5 block text-xs leading-snug', UI.muted)}>{helpLine(row.hint)}</span>}
    </th>
  )
}

function DataRow({ row, showHelp, significant }: { row: ComparisonRow; showHelp: boolean; significant: boolean }) {
  const winner = row.winner
  const rowClass = clsx(
    'border-t border-zinc-100 dark:border-zinc-800',
    row.primary && 'bg-zinc-50 dark:bg-zinc-800/40',
    row.informative && 'text-zinc-500 dark:text-zinc-400',
  )

  if (row.shared) {
    // The value belongs to the pair (p-value): rendered once.
    return (
      <tr className={rowClass}>
        <MetricCell row={row} showHelp={showHelp} />
        <td colSpan={2} className="px-1.5 py-2 sm:px-3 text-center align-top tabular-nums">
          <span className="font-medium">{formatRowValue(row, 'gpt')}</span>
          <span className={clsx('block text-xs', UI.muted)}>{significant ? 'significativa' : 'no significativa'}</span>
        </td>
        <td className="hidden px-1.5 py-2 sm:px-3 sm:table-cell" />
        <td className="px-1.5 py-2 sm:px-3 text-xs text-zinc-500 dark:text-zinc-400">Sin ganador</td>
      </tr>
    )
  }

  return (
    <tr className={rowClass}>
      <MetricCell row={row} showHelp={showHelp} />
      {ENGINE_IDS.map((e) => {
        const best = winner === e
        return (
          <td
            key={e}
            className={clsx(
              'px-1.5 py-2 text-right align-top tabular-nums sm:whitespace-nowrap sm:px-3',
              best && clsx('font-bold', ENGINE_THEME[e].soft, ENGINE_THEME[e].text),
            )}
          >
            {best && <BestMark />}
            {formatRowValue(row, e)}
          </td>
        )
      })}
      <td className="hidden px-1.5 py-2 sm:px-3 text-right align-top text-xs tabular-nums sm:table-cell">{row.deltaText || '—'}</td>
      <td className="px-1.5 py-2 sm:px-3 align-top">
        {isEngineWinner(winner) ? <WinnerChip winner={winner} /> : <span className="text-xs text-zinc-500 dark:text-zinc-400">{winner === 'tie' ? 'Empate' : '—'}</span>}
        {row.deltaText && <span className="mt-1 block text-xs tabular-nums text-zinc-600 sm:hidden dark:text-zinc-300">{row.deltaText}</span>}
        <span className="sr-only">{winner === null && row.informative ? 'Sin ganador, informativo' : winnerLabel(winner)}</span>
      </td>
    </tr>
  )
}

function GroupHeader({ group, comparison }: { group: RowGroup; comparison: Comparison }) {
  const verdict = isVerdictPillar(group.pillar) ? comparison.pillars[group.pillar] : null
  return (
    <tr className="bg-zinc-100 dark:bg-zinc-800">
      <th colSpan={5} scope="colgroup" className="px-1.5 py-2 sm:px-3 text-left">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{group.label}</span>
          {verdict ? (
            <span className="flex items-center gap-1.5 text-xs font-normal text-zinc-600 dark:text-zinc-300">
              Resultado: <WinnerChip winner={verdict.winner} />
              {verdict.detail && <span>· {verdict.detail}</span>}
            </span>
          ) : (
            <span className="text-xs font-normal text-zinc-500 dark:text-zinc-400">Informativo: no entra al veredicto.</span>
          )}
        </span>
      </th>
    </tr>
  )
}

export function ComparisonTable({ comparison }: { comparison: Comparison }) {
  // Help lines are on by default except on phones, where the narrow column makes them very tall.
  const [showHelp, setShowHelp] = useState(() => typeof window === 'undefined' || typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 640px)').matches)
  const helpId = useId()
  const groups = groupRows(comparison.rows)
  return (
    <section aria-labelledby="cmp-table-title" className={SECTION_CARD}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="cmp-table-title" className={SECTION_TITLE}>
            Métricas por pilar
          </h3>
          <p className={SECTION_LEAD}>
            Las filas con la etiqueta «Decide» determinan el veredicto del pilar; las «Informativo» solo dan contexto. Δ es la ventaja del ganador
            (empate = diferencia dentro de la tolerancia).
          </p>
        </div>
        <label htmlFor={helpId} className="flex shrink-0 cursor-pointer items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input id={helpId} type="checkbox" checked={showHelp} onChange={(e) => setShowHelp(e.target.checked)} className="size-4 accent-zinc-800 dark:accent-zinc-200" />
          Explicar cada métrica
        </label>
      </div>

      <div className="relative mt-3 overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="w-full border-collapse text-[13px] sm:text-sm">
          <caption className="sr-only">Comparación de métricas entre GPT y Jev, agrupadas por pilar</caption>
          <thead>
            <tr className="text-xs text-zinc-500 dark:text-zinc-400">
              <th scope="col" className="px-1.5 py-2 sm:px-3 text-left font-medium">
                Métrica
              </th>
              {ENGINE_IDS.map((e) => (
                <th key={e} scope="col" className="px-1.5 py-2 sm:px-3 text-right font-medium">
                  {ENGINE_THEME[e].label}
                </th>
              ))}
              <th scope="col" className="hidden px-1.5 py-2 sm:px-3 text-right font-medium sm:table-cell" title="Ventaja del ganador sobre el otro motor">
                Δ ventaja
              </th>
              <th scope="col" className="px-1.5 py-2 sm:px-3 text-left font-medium">
                Ganador
              </th>
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.pillar}>
              <GroupHeader group={g} comparison={comparison} />
              {g.rows.map((r) => (
                <DataRow key={r.key} row={r} showHelp={showHelp} significant={comparison.paired.significant} />
              ))}
            </tbody>
          ))}
        </table>
      </div>
    </section>
  )
}
