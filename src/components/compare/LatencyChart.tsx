/**
 * Latency distribution per engine: grouped columns for p50, p90, p95 and max (end-to-end, ms).
 * The p50 pair decides the Time pillar; its values are in the legend, the tooltip and the table twin.
 */
import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TooltipContentProps } from 'recharts'
import { ENGINE_IDS, type EngineId } from '../../shared/contracts.ts'
import { ENGINE_LABELS, int, ms } from '../../metrics/index.ts'
import type { LaneMetrics } from '../../metrics/index.ts'
import { ChartCard, ChartLegend, TooltipBox } from './chartParts.tsx'
import { latencyMax, latencyRows, niceAxis, type LatencyRow, type LatencyStat } from './chartData.ts'
import { AXIS_STROKE, AXIS_TICK, GRID_STROKE, SERIES_COLOR, msTick } from './compareTheme.ts'

const STAT_HELP: Record<LatencyStat, string> = {
  p50: 'mediana: la mitad tardó menos',
  p90: 'el 90 % tardó menos',
  p95: 'el 95 % tardó menos',
  max: 'la clasificación más lenta',
}

function renderTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload as LatencyRow | undefined
  if (!row) return null
  return (
    <TooltipBox
      title={`${row.label} · ${STAT_HELP[row.stat]}`}
      rows={ENGINE_IDS.map((e) => ({ engine: e, label: ENGINE_LABELS[e], value: row[e] === null ? 'sin datos' : ms(row[e]) }))}
    />
  )
}

export function LatencyChart({ gpt, jev }: { gpt: LaneMetrics; jev: LaneMetrics }) {
  const rows = useMemo(() => latencyRows(gpt.timing.latency, jev.timing.latency), [gpt.timing.latency, jev.timing.latency])
  const axis = useMemo(() => niceAxis(latencyMax(rows)), [rows])
  const empty = gpt.timing.latency === null && jev.timing.latency === null
  const lanes: Record<EngineId, LaneMetrics> = { gpt, jev }

  return (
    <ChartCard
      title="Latencias por motor"
      subtitle="Tiempo de cada clasificación de extremo a extremo (incluye reintentos y timeouts). Cada grupo muestra qué tan lenta fue la mediana (p50, la que decide el pilar), la cola (p90, p95) y el peor caso. Columnas más bajas = más rápido."
      legend={
        <ChartLegend
          items={ENGINE_IDS.map((e) => {
            const l = lanes[e].timing.latency
            return { engine: e, label: ENGINE_LABELS[e], kind: 'bar' as const, note: l ? `p50 ${ms(l.p50)} · n = ${int(l.count)}` : 'sin datos' }
          })}
        />
      }
      empty={empty}
      emptyText="Las latencias aparecerán aquí a medida que los carriles clasifiquen conceptos."
      table={{
        head: ['Estadístico', 'GPT', 'Jev'],
        rows: rows.map((r) => [`${r.label} (${STAT_HELP[r.stat]})`, r.gpt === null ? null : ms(r.gpt), r.jev === null ? null : ms(r.jev)]),
      }}
      summary={`Latencias de extremo a extremo. ${ENGINE_IDS.map((e) => {
        const l = lanes[e].timing.latency
        return l ? `${ENGINE_LABELS[e]}: p50 ${ms(l.p50)}, p95 ${ms(l.p95)}, máximo ${ms(l.max)}` : `${ENGINE_LABELS[e]}: sin datos`
      }).join('; ')}.`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 4, left: 0 }} barGap={2} barCategoryGap="22%">
          <CartesianGrid stroke={GRID_STROKE} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: AXIS_STROKE }} />
          <YAxis tickFormatter={msTick} tick={AXIS_TICK} tickLine={false} axisLine={false} width={56} domain={[0, axis.max]} ticks={axis.ticks} />
          <Tooltip content={renderTooltip} isAnimationActive={false} cursor={{ fill: AXIS_STROKE, fillOpacity: 0.12 }} />
          {ENGINE_IDS.map((e) => (
            <Bar key={e} dataKey={e} name={ENGINE_LABELS[e]} fill={SERIES_COLOR[e]} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}
