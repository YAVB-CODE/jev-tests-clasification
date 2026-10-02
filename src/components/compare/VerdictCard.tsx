/** Global verdict: who classified better, pillars won per engine and the validity warnings. */
import clsx from 'clsx'
import { PILLARS, PILLAR_LABELS } from '../../metrics/index.ts'
import type { Comparison } from '../../metrics/index.ts'
import { ENGINE_IDS } from '../../shared/contracts.ts'
import { UI } from '../ui/theme.ts'
import { SECTION_CARD } from './compareTheme.ts'
import { isEngineWinner, validityView, winnerAccent, winnerHeadline } from './panelData.ts'
import type { PartialState } from './panelData.ts'
import { EngineMark, EngineName, WinnerChip } from './panelParts.tsx'

function ValidityBanner({ comparison }: { comparison: Comparison }) {
  const view = validityView(comparison.validity)
  if (view.valid && view.cautions.length > 0) {
    // Valid (nothing blocks the verdict) but not green: e.g. > 20 % errors / timeouts in a lane.
    return (
      <div
        role="status"
        className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
      >
        <p className="flex items-center gap-2 font-semibold">
          <span aria-hidden>⚠</span>
          {view.title}
        </p>
        <p>{view.lead}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {view.cautions.map((i) => (
            <li key={`${i.code}-${i.engine ?? ''}`}>{i.message}</li>
          ))}
        </ul>
      </div>
    )
  }
  if (view.valid) {
    return (
      <div className="rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300">
        <p className="flex items-center gap-2 font-semibold">
          <span aria-hidden className="font-bold">
            ✓
          </span>
          {view.title}
        </p>
        <p>Ambos carriles reales, corrida completa y mismos conceptos.</p>
      </div>
    )
  }
  return (
    <div
      role="alert"
      className="rounded-lg border border-amber-300 border-l-8 border-l-amber-500 bg-amber-50 px-4 py-3 text-amber-950 dark:border-amber-800 dark:border-l-amber-500 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <p className="flex items-center gap-2 text-base font-bold">
        <span aria-hidden>⚠</span>
        {view.title}
      </p>
      <p className="mt-1 text-sm">{view.lead}</p>
      <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm">
        {view.blocking.map((i) => (
          <li key={`${i.code}-${i.engine ?? ''}`}>{i.message}</li>
        ))}
      </ul>
    </div>
  )
}

export function VerdictCard({ comparison, partial }: { comparison: Comparison; partial: PartialState }) {
  const { overall, pillars, validity } = comparison
  const view = validityView(validity)
  const winner = overall.winner
  return (
    <section aria-labelledby="cmp-verdict-title" className={clsx(SECTION_CARD, 'space-y-4')} style={{ borderTop: `4px solid ${winnerAccent(winner)}` }}>
      <ValidityBanner comparison={comparison} />

      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="min-w-0 flex-1 basis-80">
          <p className={UI.label}>Veredicto global{partial.partial ? ` (${partial.label})` : ''}</p>
          <h3 id="cmp-verdict-title" className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-3xl font-bold text-zinc-900 dark:text-zinc-50">
            {isEngineWinner(winner) && <EngineMark engine={winner} size={22} />}
            {winnerHeadline(winner)}
            {!view.valid && (
              <span className="rounded-full border border-amber-400 bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-900 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-200">
                Provisional
              </span>
            )}
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{overall.summary}</p>
          {overall.decidedByScore && (
            <p className={clsx('mt-1 text-xs', UI.muted)}>Los pilares quedaron parejos: decidió el Score.</p>
          )}
        </div>

        <dl aria-label="Pilares ganados" className="grid shrink-0 grid-cols-3 gap-2 text-center">
          {ENGINE_IDS.map((e) => (
            <div key={e} className="min-w-20 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700">
              <dt className="flex items-center justify-center text-xs text-zinc-600 dark:text-zinc-300">
                <EngineName engine={e} />
              </dt>
              <dd className="text-2xl font-bold tabular-nums text-zinc-900 dark:text-zinc-50">{overall.pillarsWon[e]}</dd>
              <dd className={clsx('text-[11px]', UI.muted)}>{overall.pillarsWon[e] === 1 ? 'pilar' : 'pilares'}</dd>
            </div>
          ))}
          <div className="min-w-20 rounded-lg border border-zinc-200 px-3 py-2 dark:border-zinc-700">
            <dt className="text-xs text-zinc-600 dark:text-zinc-300">Empates</dt>
            <dd className="text-2xl font-bold tabular-nums text-zinc-900 dark:text-zinc-50">{overall.pillarsTied}</dd>
            <dd className={clsx('text-[11px]', UI.muted)}>
              {overall.pillarsWithoutData > 0 ? `${overall.pillarsWithoutData} sin datos` : 'pilares'}
            </dd>
          </div>
        </dl>
      </div>

      <ul className="flex flex-wrap gap-2" aria-label="Ganador por pilar">
        {PILLARS.map((p) => (
          <li key={p} className="flex items-center gap-2 rounded-lg bg-zinc-50 px-3 py-1.5 text-sm dark:bg-zinc-800/60">
            <span className="font-medium text-zinc-800 dark:text-zinc-200">{PILLAR_LABELS[p]}</span>
            <WinnerChip winner={pillars[p].winner} />
          </li>
        ))}
      </ul>

      {view.notes.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-800/50 dark:text-zinc-300">
          <p className="font-semibold">Ten en cuenta</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {view.notes.map((i) => (
              <li key={`${i.code}-${i.engine ?? ''}`}>{i.message}</li>
            ))}
          </ul>
        </div>
      )}

      <details className="text-sm text-zinc-700 dark:text-zinc-300">
        <summary className="cursor-pointer font-medium text-zinc-900 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-zinc-500 dark:text-zinc-100">
          Cómo se decidió
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {overall.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      </details>
    </section>
  )
}
