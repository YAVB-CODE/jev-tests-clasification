/**
 * Accuracy by difficulty (easy / medium / hard) per engine: grouped columns on a 0–100 % axis.
 * A missing bucket is labeled "s/d" at the baseline so it is never read as 0 % accuracy.
 */
import { useMemo } from 'react'
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { TooltipContentProps } from 'recharts'
import { ENGINE_IDS, type EngineId } from '../../shared/contracts.ts'
import { ENGINE_LABELS, pct } from '../../metrics/index.ts'
import type { LaneMetrics } from '../../metrics/index.ts'
import { ChartCard, ChartLegend, TooltipBox } from './chartParts.tsx'
import { difficultyRows, hasDifficultyData, type DifficultyRow } from './chartData.ts'
import { AXIS_STROKE, AXIS_TICK, GRID_STROKE, INK_COLOR, PCT_TICKS, SERIES_COLOR, pctTick } from './compareTheme.ts'

/** Chart row: the bar value is 0 when the bucket is empty, the real accuracy stays in `row`. */
interface BarRow extends DifficultyRow {
  gptBar: number
  jevBar: number
}

function detail(row: DifficultyRow, e: EngineId): string {
  const n = e === 'gpt' ? row.gptN : row.jevN
  const ok = e === 'gpt' ? row.gptCorrect : row.jevCorrect
  const v = row[e]
  return v === null || n === 0 ? 'sin conceptos' : `${pct(v, 1)} (${ok} de ${n})`
}

function renderTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null
  const row = payload[0]?.payload as BarRow | undefined
  if (!row) return null
  return (
    <TooltipBox
      title={`Dificultad ${row.label.toLowerCase()}`}
      rows={ENGINE_IDS.map((e) => ({ engine: e, label: ENGINE_LABELS[e], value: detail(row, e) }))}
    />
  )
}

function valueLabel(rows: readonly BarRow[], e: EngineId) {
  return function ValueLabel(props: { x?: number | string; y?: number | string; width?: number | string; index?: number }) {
    const { x, y, width, index } = props
    if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || index === undefined) return null
    const v = rows[index]?.[e]
    return (
      <text x={x + width / 2} y={y - 5} textAnchor="middle" fontSize={width < 26 ? 10 : 11} fontWeight={600} fill={INK_COLOR}>
        {v === null || v === undefined ? 's/d' : `${Math.round(v * 100)}%`}
      </text>
    )
  }
}

export function DifficultyChart({ gpt, jev }: { gpt: LaneMetrics; jev: LaneMetrics }) {
  const rows = useMemo<BarRow[]>(
    () => difficultyRows(gpt.score.byDifficulty, jev.score.byDifficulty).map((r) => ({ ...r, gptBar: r.gpt ?? 0, jevBar: r.jev ?? 0 })),
    [gpt.score.byDifficulty, jev.score.byDifficulty],
  )
  const labels = useMemo(() => ({ gpt: valueLabel(rows, 'gpt'), jev: valueLabel(rows, 'jev') }), [rows])
  const empty = !hasDifficultyData(rows)

  return (
    <ChartCard
      title="Acierto por dificultad"
      subtitle="Porcentaje de conceptos clasificados correctamente en cada nivel de dificultad del dataset. Si una columna cae a medida que sube la dificultad, el motor sufre con los casos ambiguos. «s/d» = sin conceptos de ese nivel."
      legend={
        <ChartLegend
          items={ENGINE_IDS.map((e) => ({
            engine: e,
            label: ENGINE_LABELS[e],
            kind: 'bar' as const,
            note: (e === 'gpt' ? gpt : jev).score.accuracy === null ? 'sin datos' : `total ${pct((e === 'gpt' ? gpt : jev).score.accuracy, 0)}`,
          }))}
        />
      }
      empty={empty}
      emptyText="Este dataset no trae dificultad por concepto, o aún no hay clasificaciones. El acierto por nivel aparecerá aquí."
      table={{
        head: ['Dificultad', 'GPT', 'Jev'],
        rows: rows.map((r) => [r.label, detail(r, 'gpt'), detail(r, 'jev')]),
      }}
      summary={`Acierto por dificultad. ${rows.map((r) => `${r.label}: GPT ${detail(r, 'gpt')}, Jev ${detail(r, 'jev')}`).join('; ')}.`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} margin={{ top: 22, right: 8, bottom: 4, left: 0 }} barGap={4} barCategoryGap="25%">
          <CartesianGrid stroke={GRID_STROKE} vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} tickLine={false} axisLine={{ stroke: AXIS_STROKE }} />
          <YAxis domain={[0, 1]} ticks={PCT_TICKS} tickFormatter={pctTick} tick={AXIS_TICK} tickLine={false} axisLine={false} width={48} />
          <Tooltip content={renderTooltip} isAnimationActive={false} cursor={{ fill: AXIS_STROKE, fillOpacity: 0.12 }} />
          {ENGINE_IDS.map((e) => (
            <Bar
              key={e}
              dataKey={`${e}Bar`}
              name={ENGINE_LABELS[e]}
              fill={SERIES_COLOR[e]}
              radius={[4, 4, 0, 0]}
              maxBarSize={28}
              minPointSize={0}
              isAnimationActive={false}
            >
              <LabelList dataKey={`${e}Bar`} content={labels[e]} />
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}
