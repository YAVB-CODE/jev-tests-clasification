/**
 * Reliability diagram: mean stated confidence (x) vs. observed accuracy (y) per confidence bin.
 * Bubbles carry the bin population (area and opacity); the diagonal is perfect calibration.
 */
import { useMemo } from 'react'
import type { JSX } from 'react'
import { CartesianGrid, ReferenceArea, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis } from 'recharts'
import type { ScatterShapeProps, TooltipContentProps } from 'recharts'
import type { EngineId } from '../../shared/contracts.ts'
import { ENGINE_IDS } from '../../shared/contracts.ts'
import { ENGINE_LABELS, int, num, pct, pp } from '../../metrics/index.ts'
import type { LaneMetrics } from '../../metrics/index.ts'
import { ChartCard, ChartLegend, MarkerShape, TooltipBox } from './chartParts.tsx'
import { reliabilityPoints, maxBinCount, type ReliabilityPoint } from './chartData.ts'
import { AXIS_LABEL, AXIS_STROKE, AXIS_TICK, GRID_STROKE, PCT_TICKS, SERIES_COLOR, pctTick } from './compareTheme.ts'

const Z_RANGE: [number, number] = [90, 520]

function bubbleShape(engine: EngineId) {
  return function Bubble(props: ScatterShapeProps) {
    const { cx, cy, size } = props
    if (typeof cx !== 'number' || typeof cy !== 'number') return <g />
    const r = Math.sqrt((typeof size === 'number' ? size : 90) / Math.PI)
    const opacity = (props.payload as ReliabilityPoint | undefined)?.opacity ?? 1
    return <MarkerShape engine={engine} cx={cx} cy={cy} r={r} opacity={opacity} />
  }
}

const SHAPES: Record<EngineId, (props: ScatterShapeProps) => JSX.Element> = { gpt: bubbleShape('gpt'), jev: bubbleShape('jev') }

function renderTooltip({ active, payload }: TooltipContentProps) {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload as ReliabilityPoint | undefined
  if (!d) return null
  const verdict = Math.abs(d.gap) < 0.005 ? 'calibrado' : d.gap < 0 ? 'sobreconfiado' : 'subconfiado'
  return (
    <TooltipBox
      title={`${ENGINE_LABELS[d.engine]} · confianza ${Math.round(d.lo * 100)}–${Math.round(d.hi * 100)} %`}
      rows={[
        { engine: d.engine, value: pct(d.accuracy, 0), label: 'acierto real' },
        { engine: d.engine, value: pct(d.confidence, 0), label: 'confianza media' },
        { engine: d.engine, value: int(d.n), label: d.n === 1 ? 'respuesta' : 'respuestas' },
      ]}
      footer={`${verdict} (${pp(d.gap, 0)} entre acierto y confianza)`}
    />
  )
}

export function ReliabilityChart({ gpt, jev }: { gpt: LaneMetrics; jev: LaneMetrics }) {
  const lanes: Record<EngineId, LaneMetrics> = { gpt, jev }
  const points = useMemo(() => {
    const maxN = maxBinCount(gpt.reliability.bins, jev.reliability.bins)
    return {
      gpt: reliabilityPoints('gpt', gpt.reliability.bins, maxN),
      jev: reliabilityPoints('jev', jev.reliability.bins, maxN),
      maxN,
    }
  }, [gpt.reliability.bins, jev.reliability.bins])

  const empty = points.gpt.length === 0 && points.jev.length === 0
  const missing = ENGINE_IDS.filter((e) => points[e].length === 0).map((e) => ENGINE_LABELS[e])

  const tableRows = ENGINE_IDS.flatMap((e) =>
    points[e].map((p) => [
      `${ENGINE_LABELS[e]} · ${Math.round(p.lo * 100)}–${Math.round(p.hi * 100)} %`,
      p.n,
      pct(p.confidence, 1),
      pct(p.accuracy, 1),
      pp(p.gap, 1),
    ]),
  )

  return (
    <ChartCard
      title="Diagrama de confiabilidad"
      subtitle="Cada burbuja es un intervalo de confianza: en el eje X lo seguro que dijo estar y en el Y cuánto acertó de verdad. Sobre la diagonal = calibrado; por debajo = sobreconfiado. Más grande y más opaca = más respuestas."
      legend={
        <ChartLegend
          items={ENGINE_IDS.map((e) => {
            const r = lanes[e].reliability
            return {
              engine: e,
              label: ENGINE_LABELS[e],
              kind: 'marker' as const,
              note: r.n > 0 ? `ECE ${num(r.ece)} · n = ${int(r.n)}` : 'sin confianza declarada',
            }
          })}
        />
      }
      empty={empty}
      emptyText="Aún no hay respuestas válidas con confianza declarada. Aparecerán aquí cuando los carriles las reporten."
      table={{ head: ['Motor · intervalo', 'n', 'Confianza media', 'Acierto', 'Brecha'], rows: tableRows }}
      summary={`Diagrama de confiabilidad. ${ENGINE_IDS.map((e) => `${ENGINE_LABELS[e]}: ECE ${num(lanes[e].reliability.ece)} en ${int(lanes[e].reliability.n)} respuestas`).join('; ')}.`}
      footnote={missing.length > 0 ? <p>{missing.join(' y ')}: sin confianza declarada, no aparece en el diagrama.</p> : undefined}
    >
      <ResponsiveContainer width="100%" height="100%">
        <ScatterChart margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid stroke={GRID_STROKE} />
          <XAxis
            type="number"
            dataKey="confidence"
            name="Confianza"
            domain={[0, 1]}
            ticks={PCT_TICKS}
            tickFormatter={pctTick}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={{ stroke: AXIS_STROKE }}
            height={42}
            label={{ value: 'Confianza declarada (media del intervalo)', position: 'insideBottom', offset: 0, ...AXIS_LABEL }}
          />
          <YAxis
            type="number"
            dataKey="accuracy"
            name="Acierto"
            domain={[0, 1]}
            ticks={PCT_TICKS}
            tickFormatter={pctTick}
            tick={AXIS_TICK}
            tickLine={false}
            axisLine={false}
            width={48}
          />
          <ZAxis type="number" dataKey="n" domain={[0, points.maxN]} range={Z_RANGE} />
          <ReferenceArea
            x1={0.5}
            x2={1}
            y1={0}
            y2={0.14}
            fill="transparent"
            stroke="none"
            ifOverflow="visible"
            label={{ value: 'Sobreconfiado ↓', position: 'insideBottomRight', ...AXIS_LABEL }}
          />
          <ReferenceLine
            segment={[
              { x: 0, y: 0 },
              { x: 1, y: 1 },
            ]}
            stroke={AXIS_STROKE}
            strokeWidth={1}
            ifOverflow="visible"
            label={{ value: 'Calibración perfecta', position: 'insideTopLeft', ...AXIS_LABEL }}
          />
          <Tooltip content={renderTooltip} isAnimationActive={false} cursor={false} />
          {ENGINE_IDS.map((e) => (
            <Scatter
              key={e}
              name={ENGINE_LABELS[e]}
              data={points[e]}
              fill={SERIES_COLOR[e]}
              shape={SHAPES[e]}
              isAnimationActive={false}
            />
          ))}
        </ScatterChart>
      </ResponsiveContainer>
    </ChartCard>
  )
}
