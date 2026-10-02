/** Three pillar cards (Score / Confiabilidad / Tiempo): winner, how it was decided and the key numbers. */
import clsx from 'clsx'
import { ENGINE_LABELS, PILLARS, formatRowValue, int, pValue, SIGNIFICANCE_ALPHA, num } from '../../metrics/index.ts'
import type { Comparison, ComparisonRow, Pillar, PillarVerdict } from '../../metrics/index.ts'
import { ENGINE_IDS } from '../../shared/contracts.ts'
import { UI } from '../ui/theme.ts'
import { SECTION_CARD } from './compareTheme.ts'
import { decidedByLabel, directionLabel, focusRows, winnerAccent, winnerHeadline } from './panelData.ts'
import { BestMark, EngineMark, WinnerChip } from './panelParts.tsx'

const PILLAR_BLURB: Record<Pillar, string> = {
  score: '¿Quién acierta más subcuentas?',
  reliability: '¿Se puede creer en su confianza?',
  time: '¿Quién responde más rápido?',
}

function SignificanceBadge({ verdict }: { verdict: PillarVerdict }) {
  if (verdict.pValue === undefined) return null
  if (verdict.pValue === null) {
    return <p className={clsx('text-xs', UI.muted)}>Sin pares comparables para la prueba de significancia.</p>
  }
  const sig = verdict.significant === true
  return (
    <p
      className={clsx(
        'rounded-md border px-2.5 py-1.5 text-xs',
        sig
          ? 'border-green-200 bg-green-50 text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300'
          : 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-300',
      )}
    >
      <strong className="font-semibold">
        {sig ? '✓ Diferencia significativa' : '≈ Diferencia no significativa'}
      </strong>{' '}
      ({pValue(verdict.pValue)}, α = {num(SIGNIFICANCE_ALPHA, 2)}).{' '}
      {sig ? 'Es poco probable que se deba al azar.' : 'Con esta muestra podría deberse al azar.'}
    </p>
  )
}

function VotesLine({ verdict }: { verdict: PillarVerdict }) {
  const v = verdict.votes
  if (!v) return null
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-700 dark:text-zinc-300">
      <span className="font-semibold">Votos:</span>
      {ENGINE_IDS.map((e) => (
        <span key={e} className="inline-flex items-center gap-1">
          <EngineMark engine={e} size={10} />
          {ENGINE_LABELS[e]} <strong className="tabular-nums">{v[e]}</strong>
        </span>
      ))}
      <span>
        Empates <strong className="tabular-nums">{v.tie}</strong>
      </span>
      {v.abstain > 0 && (
        <span>
          Sin datos <strong className="tabular-nums">{v.abstain}</strong>
        </span>
      )}
    </p>
  )
}

function FocusTable({ rows }: { rows: ComparisonRow[] }) {
  if (rows.length === 0) return null
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className={clsx('text-xs', UI.muted)}>
          <th scope="col" className="py-1 text-left font-medium">
            Métrica
          </th>
          {ENGINE_IDS.map((e) => (
            <th key={e} scope="col" className="py-1 text-right font-medium">
              {ENGINE_LABELS[e]}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className="border-t border-zinc-100 dark:border-zinc-800">
            <th scope="row" className="py-1.5 pr-2 text-left font-normal text-zinc-700 dark:text-zinc-300">
              {r.label}
              <span className={clsx('block text-[11px]', UI.muted)}>{directionLabel(r.better)}</span>
            </th>
            {ENGINE_IDS.map((e) => {
              const best = r.winner === e
              return (
                <td
                  key={e}
                  className={clsx('py-1.5 text-right tabular-nums', best ? 'font-bold text-zinc-900 dark:text-zinc-50' : 'text-zinc-600 dark:text-zinc-300')}
                >
                  {best && <BestMark />}
                  {formatRowValue(r, e)}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function PillarCard({ pillar, comparison }: { pillar: Pillar; comparison: Comparison }) {
  const verdict = comparison.pillars[pillar]
  const how = decidedByLabel(verdict, comparison.rows)
  const titleId = `cmp-pillar-${pillar}`
  return (
    <section
      aria-labelledby={titleId}
      className={clsx(SECTION_CARD, 'flex min-w-0 flex-col gap-3')}
      style={{ borderTop: `4px solid ${winnerAccent(verdict.winner)}` }}
    >
      <header className="flex items-start justify-between gap-2">
        <div>
          <h4 id={titleId} className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            {verdict.label}
          </h4>
          <p className={clsx('text-xs', UI.muted)}>{PILLAR_BLURB[pillar]}</p>
        </div>
        <WinnerChip winner={verdict.winner} />
      </header>

      <div>
        <p className="text-xl font-bold text-zinc-900 dark:text-zinc-50">{winnerHeadline(verdict.winner)}</p>
        {verdict.detail && <p className="text-sm text-zinc-600 dark:text-zinc-300">{verdict.detail}</p>}
        {how && (
          <p className={clsx('mt-0.5 text-xs', UI.muted)}>
            Decidido por: <span className="font-medium text-zinc-700 dark:text-zinc-300">{how}</span>
          </p>
        )}
      </div>

      <FocusTable rows={focusRows(pillar, comparison.rows)} />
      {pillar === 'score' && <SignificanceBadge verdict={verdict} />}
      {pillar === 'reliability' && <VotesLine verdict={verdict} />}

      {verdict.reasons.length > 0 && (
        <details open className="mt-auto text-xs text-zinc-600 dark:text-zinc-300">
          <summary className="cursor-pointer font-medium text-zinc-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 dark:text-zinc-200">
            Cómo se decidió ({int(verdict.reasons.length)} {verdict.reasons.length === 1 ? 'paso' : 'pasos'})
          </summary>
          <ol className="mt-1.5 list-decimal space-y-1 pl-4">
            {verdict.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ol>
        </details>
      )}
    </section>
  )
}

export function PillarCards({ comparison }: { comparison: Comparison }) {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {PILLARS.map((p) => (
        <PillarCard key={p} pillar={p} comparison={comparison} />
      ))}
    </div>
  )
}

