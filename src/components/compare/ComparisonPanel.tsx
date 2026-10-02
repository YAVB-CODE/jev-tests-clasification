/**
 * "Who classified better?" — comparison panel mounted under the split screen.
 * Verdict → pillar cards → metrics table → charts → paired test. Updates live while the run is
 * in progress (labeled «parcial»), and says explicitly when the result is not valid to evaluate
 * efficacy (simulated lane, incomplete run, ...).
 */
import clsx from 'clsx'
import { lazy, Suspense } from 'react'
import { useBench } from '../../bench/useBench.ts'
import { int } from '../../metrics/index.ts'
import { useComparison, useLaneMetrics } from '../metrics/hooks.ts'
import { UI } from '../ui/theme.ts'
import { ComparisonTable } from './ComparisonTable.tsx'
import { PairedTestCard } from './PairedTestCard.tsx'
import { PillarCards } from './PillarCards.tsx'
import { VerdictCard } from './VerdictCard.tsx'
import { PANEL_VARS, SECTION_CARD, SECTION_LEAD, SECTION_TITLE } from './compareTheme.ts'
import { loadComparisonCharts } from './loadCharts.ts'
import { partialState } from './panelData.ts'

/** recharts lives in its own chunk (see loadCharts.ts). */
const ComparisonCharts = lazy(loadComparisonCharts)

function ChartsFallback() {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2" role="status" aria-label="Cargando gráficas">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className={clsx(SECTION_CARD, 'grid h-80 place-items-center text-sm', UI.muted)}>
          {i === 0 ? 'Cargando gráficas…' : null}
        </div>
      ))}
    </div>
  )
}

function EmptyState({ running, gpt, jev }: { running: boolean; gpt: number; jev: number }) {
  return (
    <div className={clsx(SECTION_CARD, 'text-sm text-zinc-700 dark:text-zinc-300')}>
      {running ? (
        <>
          <p className="font-semibold text-zinc-900 dark:text-zinc-100">Esperando respuestas de ambos carriles…</p>
          <p className={clsx('mt-1', UI.muted)}>
            La comparación aparece en cuanto GPT y Jev tengan al menos una clasificación (ahora: GPT {int(gpt)}, Jev {int(jev)}) y se actualiza en vivo.
          </p>
        </>
      ) : (
        <>
          <p className="font-semibold text-zinc-900 dark:text-zinc-100">Todavía no hay resultados para comparar.</p>
          <p className={clsx('mt-1', UI.muted)}>Cuando ejecutes una corrida verás aquí:</p>
          <ul className="mt-2 list-disc space-y-1 pl-5">
            <li>el veredicto global: quién clasificó mejor y en cuántos pilares;</li>
            <li>el ganador de cada pilar (Score, Confiabilidad y Tiempo) y cómo se decidió;</li>
            <li>una tabla con todas las métricas y cuatro gráficas (confiabilidad, latencias, dificultad y riesgo–cobertura);</li>
            <li>la prueba pareada: si la diferencia de acierto es real o puede ser azar.</li>
          </ul>
        </>
      )}
    </div>
  )
}

export default function ComparisonPanel() {
  const comparison = useComparison()
  const gpt = useLaneMetrics('gpt')
  const jev = useLaneMetrics('jev')
  const status = useBench((s) => s.status)

  const lanes = [gpt, jev].filter((m): m is NonNullable<typeof m> => m !== null)
  const partial = partialState(
    status,
    lanes.map((m) => ({ pending: m.counts.pending, runStatus: m.runStatus })),
  )

  return (
    <section id="comparacion" aria-labelledby="cmp-title" aria-busy={status === 'running'} className={clsx('space-y-4', PANEL_VARS)}>
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div>
          <h2 id="cmp-title" className={clsx(SECTION_TITLE, 'text-lg')}>
            Comparación: ¿quién clasificó mejor?
          </h2>
          <p className={SECTION_LEAD}>GPT (LLM tradicional) contra Jev (System One) sobre los mismos conceptos, en Score, Confiabilidad y Tiempo.</p>
        </div>
        {partial.partial && comparison && (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200"
          >
            <span aria-hidden className={clsx('size-2 rounded-full bg-amber-500', status === 'running' && 'motion-safe:animate-pulse')} />
            {partial.label}
          </span>
        )}
      </header>

      {comparison === null || gpt === null || jev === null ? (
        <EmptyState running={status === 'running'} gpt={gpt?.counts.completed ?? 0} jev={jev?.counts.completed ?? 0} />
      ) : (
        <>
          <VerdictCard comparison={comparison} partial={partial} />
          <PillarCards comparison={comparison} />
          <ComparisonTable comparison={comparison} />
          <Suspense fallback={<ChartsFallback />}>
            <ComparisonCharts gpt={gpt} jev={jev} />
          </Suspense>
          <PairedTestCard paired={comparison.paired} />
        </>
      )}
    </section>
  )
}
