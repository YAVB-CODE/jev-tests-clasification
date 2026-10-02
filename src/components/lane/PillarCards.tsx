import clsx from 'clsx'
import { DASH, fixed, int, ms, num, pct, seconds, usd, type LaneMetrics } from '../../metrics/index.ts'
import type { EngineId } from '../../shared/contracts.ts'
import { ENGINE_THEME, UI } from '../ui/theme.ts'

interface PillarRow {
  label: string
  value: string
  title?: string
}

/** One pillar: label, headline value, caption and exactly two detail rows (same height in both lanes). */
function PillarCard({
  title,
  caption,
  headline,
  rows,
  accent,
}: {
  title: string
  caption: string
  headline: string
  rows: [PillarRow, PillarRow]
  accent: string
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-lg border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-950/50">
      <h3 className={UI.label}>{title}</h3>
      <p className={clsx('mt-1.5 truncate text-xl leading-none font-semibold tabular-nums', accent)}>{headline}</p>
      <p className="mt-1 truncate text-[11px] text-zinc-500 dark:text-zinc-400" title={caption}>
        {caption}
      </p>
      <dl className="mt-2 space-y-1 border-t border-zinc-100 pt-2 text-xs dark:border-zinc-800">
        {rows.map((row) => (
          <div key={row.label} className="flex items-baseline justify-between gap-2" title={row.title}>
            <dt className="shrink-0 text-zinc-500 dark:text-zinc-400">{row.label}</dt>
            <dd className="min-w-0 truncate font-medium tabular-nums">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  )
}

function ratioText(correct: number, n: number): string {
  return n > 0 ? `${int(correct)} / ${int(n)}` : DASH
}

/** Score, Confiabilidad and Tiempo with live values; dashes before the first record. */
export function PillarCards({ engine, metrics }: { engine: EngineId; metrics: LaneMetrics | null }) {
  const accent = ENGINE_THEME[engine].text
  const score = metrics?.score
  const ci = score?.accuracyCi
  const reliability = metrics?.reliability
  const latency = metrics?.timing.latency

  return (
    <div className="grid gap-2 @[26rem]:grid-cols-3">
      <PillarCard
        title="Score"
        caption="acierto exacto"
        headline={pct(score?.accuracy)}
        accent={accent}
        rows={[
          {
            label: 'IC 95 %',
            value: ci ? `${fixed(ci.lo * 100, 0)}–${pct(ci.hi, 0)}` : DASH,
            title: 'Intervalo de confianza de Wilson al 95 % para el acierto',
          },
          { label: 'Correctos', value: ratioText(score?.correct ?? 0, metrics?.counts.completed ?? 0), title: 'Correctos / completados' },
        ]}
      />
      <PillarCard
        title="Confiabilidad"
        caption="ECE · menor es mejor"
        headline={num(reliability?.ece)}
        accent={accent}
        rows={[
          { label: 'Brier', value: num(reliability?.brier), title: 'Error cuadrático de la confianza (menor es mejor)' },
          { label: 'Válidas', value: pct(reliability?.validRate), title: 'Clasificaciones con una subcuenta válida (sin respuestas inválidas, errores ni timeouts)' },
        ]}
      />
      <PillarCard
        title="Tiempo"
        caption="p50 · menor es mejor"
        headline={ms(latency?.p50)}
        accent={accent}
        rows={[
          { label: 'p95', value: ms(latency?.p95), title: 'Latencia p95 (peor caso habitual)' },
          { label: 'Total', value: seconds(metrics?.timing.wallTimeMs), title: 'Tiempo total del lote' },
        ]}
      />
    </div>
  )
}

/** Cost and tokens, informative only (one line, same height in both lanes). */
export function CostLine({ metrics }: { metrics: LaneMetrics | null }) {
  const cost = metrics?.cost
  let text = 'Costo y tokens: —'
  if (cost && cost.usageRecords > 0) {
    const money =
      cost.costUsd !== undefined ? usd(cost.costUsd) : cost.costedRecords > 0 ? `≥ ${usd(cost.knownCostUsd)}` : DASH
    text = `Costo ${money}${cost.estimated ? ' (estimado)' : ''} · tokens ${int(cost.inputTokens)} entrada / ${int(cost.outputTokens)} salida`
  }
  return (
    <p className="truncate text-[11px] text-zinc-500 tabular-nums dark:text-zinc-400" title={text}>
      {text}
    </p>
  )
}
