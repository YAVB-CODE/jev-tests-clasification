/**
 * Risk–coverage (selective accuracy): accuracy when only the N % most confident answers are kept.
 * A curve that falls as coverage grows means the stated confidence is useful to filter answers.
 */
import { useMemo } from 'react'
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TooltipContentProps } from 'recharts'
import { ENGINE_IDS, type EngineId } from '../../shared/contracts.ts'
import { ENGINE_LABELS, int, num, pct } from '../../metrics/index.ts'
import type { LaneMetrics } from '../../metrics/index.ts'
import { ChartCard, ChartLegend, MarkerShape, TooltipBox } from './chartParts.tsx'
import { coverageRows, coverageTakeaway, type CoverageRow } from './chartData.ts'
import { AXIS_LABEL, AXIS_STROKE, AXIS_TICK, GRID_STROKE, PCT_TICKS, SERIES_COLOR, pctTick } from './compareTheme.ts'

const X_TICKS = [0.1, 0.25, 0.5, 0.75, 1]

function renderTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload as CoverageRow | undefined
  if (!row) return null
  return (
    <TooltipBox
      title={`Quedándose con el ${pct(row.coverage, 0)} más confiado`}
      rows={ENGINE_IDS.filter((e) => row[e] !== null).map((e) => ({
        engine: e,
        label: `${ENGINE_LABELS[e]} · ${int(e === 'gpt' ? row.gptCount : row.jevCount)} resp.`,
        value: pct(row[e], 1),
      }))}
      footer="Acierto de las respuestas aceptadas"
    />
  )
}

function dotFor(engine: EngineId, r: number) {
  return function Dot(props: { cx?: number; cy?: number; index?: number; value?: unknown }) {
    const { cx, cy, index, value } = props
    if (typeof cx !== 'number' || typeof cy !== 'number' || typeof value !== 'number') return <g key={`d-${engine}-${index ?? 0}`} />
    return (
      <g key={`d-${engine}-${index ?? 0}`}>
        <MarkerShape engine={engine} cx={cx} cy={cy} r={r} />
      </g>
    )
  }
}

const DOTS: Record<EngineId, ReturnType<typeof dotFor>> = { gpt: dotFor('gpt', 4), jev: dotFor('jev', 4) }
const ACTIVE_DOTS: Record<EngineId, ReturnType<typeof dotFor>> = { gpt: dotFor('gpt', 6), jev: dotFor('jev', 6) }

export function RiskCoverageChart({ gpt, jev }: { gpt: LaneMetrics; jev: LaneMetrics }) {
  const rows = useMemo(() => coverageRows(gpt.reliability.riskCoverage, jev.reliability.riskCoverage), [gpt.reliability.riskCoverage, jev.reliability.riskCoverage])
  const empty = rows.length === 0
  const lanes: Record<EngineId, LaneMetrics> = { gpt, jev }

  const takeaways = ENGINE_IDS.map((e) => coverageTakeaway(ENGINE_LABELS[e], lanes[e].reliability.riskCoverage)).filter((t): t is string => t !== null)
  const missing = ENGINE_IDS.filter((e) => lanes[e].reliability.riskCoverage.length === 0).map((e) => ENGINE_LABELS[e])

  return (
    <ChartCard
      title="Riesgo–cobertura"
      subtitle="Ordena las respuestas de más a menos confiadas y mide el acierto al quedarse solo con las primeras. Hacia la izquierda (pocas respuestas, las más seguras) la línea debería subir: eso indica que la confianza sirve para filtrar."
      legend={
        <ChartLegend
          items={ENGINE_IDS.map((e) => {
            const r = lanes[e].reliability
            return { engine: e, label: ENGINE_LABELS[e], kind: 'line' as const, note: r.n > 0 ? `AUROC ${num(r.auroc, 2)}` : 'sin confianza declarada' }
          })}
        />
      }
      empty={empty}
      emptyText="Aún no hay respuestas válidas con confianza declarada para trazar la curva."
      table={{
        head: ['Cobertura', 'GPT acierto', 'Jev acierto', 'GPT resp.', 'Jev resp.'],
        rows: rows.map((r) => [
          `${pct(r.coverage, 0)} más confiado`,
          r.gpt === null ? null : pct(r.gpt, 1),
          r.jev === null ? null : pct(r.jev, 1),
          r.gptCount > 0 ? r.gptCount : null,
          r.jevCount > 0 ? r.jevCount : null,
        ]),
      }}
      summary={`Riesgo–cobertura. ${takeaways.join(' ') || 'Sin datos suficientes.'}`}
      footnote={
        <>
          {takeaways.map((t) => (
            <p key={t}>{t}</p>
          ))}
          {missing.length > 0 && <p>{missing.join(' y ')}: sin confianza declarada, no aparece en la curva.</p>}
        </>
      }
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={GRID_STROKE} vertical={false} />
          <XAxis
            type="number"
            dataKey="coverage"
            domain={[0.1, 1]}
            ticks={X_TICKS}
            tickFormatter={pctTick}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: AXIS_STROKE }}
            height={42}
            label={{ value: 'Cobertura: % de respuestas aceptadas (las más confiadas primero)', position: 'insideBottom', offset: 0, ...AXIS_LABEL }}
          />
          <YAxis domain={[0, 1]} ticks={PCT_TICKS} tickFormatter={pctTick} tick={AXIS_TICK} tickLine={false} axisLine={false} width={48} />
          <Tooltip content={renderTooltip} isAnimationActive={false} cursor={{ stroke: AXIS_STROKE, strokeWidth: 1 }} />
          {ENGINE_IDS.map((e) => (
            <Line
              key={e}
              dataKey={e}
              name={ENGINE_LABELS[e]}
              type="linear"
              stroke={SERIES_COLOR[e]}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              dot={DOTS[e]}
              activeDot={ACTIVE_DOTS[e]}
              connectNulls
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}
