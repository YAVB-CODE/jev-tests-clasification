/** Confusions: most frequent expected → predicted mistakes per engine, and precision / recall / F1 per category side by side. */
import clsx from 'clsx'
import { Fragment, useMemo } from 'react'
import { ENGINE_IDS, type EngineId } from '../../shared/contracts.ts'
import { int, num, pct } from '../../metrics/format.ts'
import type { CategoryScore, LaneMetrics } from '../../metrics/index.ts'
import { useLaneMetrics } from '../metrics/hooks.ts'
import { ENGINE_THEME, UI } from '../ui/theme.ts'
import { CategoryLabel } from './parts.tsx'

const TH = 'sticky top-0 z-10 bg-white px-3 py-2 text-xs font-medium tracking-wide whitespace-nowrap uppercase dark:bg-zinc-900'

function TopConfusions({ engine, metrics }: { engine: EngineId; metrics: LaneMetrics | null }) {
  const theme = ENGINE_THEME[engine]
  const pairs = metrics?.score.topConfusions ?? []
  const completed = metrics?.counts.completed ?? 0
  const noAnswer = metrics ? metrics.counts.invalid + metrics.counts.error + metrics.counts.timeout : 0
  return (
    <section className={clsx(UI.card, 'min-w-0 border', theme.border)}>
      <header className={clsx('rounded-t-xl px-4 py-2.5', theme.soft)}>
        <h4 className={clsx('text-sm font-semibold', theme.text)}>{theme.label}: confusiones más frecuentes</h4>
        <p className={clsx(UI.muted, 'text-xs')}>Esperado → predicho, solo respuestas válidas.</p>
      </header>
      {pairs.length === 0 ? (
        <p className={clsx(UI.muted, 'px-4 py-4 text-sm')}>
          {completed === 0 ? 'Aún no hay resultados de este carril.' : 'Sin confusiones: todas las respuestas válidas fueron correctas.'}
        </p>
      ) : (
        <div className="relative overflow-x-auto">
          <table className="w-full min-w-120 text-left text-sm">
            <thead className={UI.muted}>
              <tr>
                <th scope="col" className="px-3 py-2 text-xs font-medium uppercase">
                  Esperado
                </th>
                <th scope="col" className="px-3 py-2 text-xs font-medium uppercase">
                  Predicho
                </th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium uppercase">
                  Veces
                </th>
                <th scope="col" className="px-3 py-2 text-right text-xs font-medium uppercase" title="Parte de los conceptos esperados de esa categoría">
                  % del esperado
                </th>
                <th scope="col" className="px-3 py-2 text-xs font-medium uppercase" title="Si ambas categorías comparten grupo (cuenta de 4 dígitos)">
                  Grupo
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {pairs.map((p) => (
                <tr key={`${p.expected}>${p.predicted}`} className="align-top">
                  <td className="px-3 py-2">
                    <CategoryLabel id={p.expected} name={p.expectedName} />
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-start gap-1.5">
                      <span aria-hidden="true" className={clsx(UI.muted, 'shrink-0')}>
                        →
                      </span>
                      <span className="sr-only">predicho como </span>
                      <CategoryLabel id={p.predicted} name={p.predictedName} />
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums">{int(p.count)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{pct(p.share, 0)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {p.sameGroup === null ? <span className={UI.muted}>—</span> : p.sameGroup ? 'Mismo grupo' : 'Otro grupo'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {noAnswer > 0 ? (
        <p className={clsx(UI.muted, 'border-t border-zinc-200 px-4 py-2 text-xs dark:border-zinc-800')}>
          {int(noAnswer)} {noAnswer === 1 ? 'respuesta' : 'respuestas'} sin categoría (inválidas, errores o timeouts): no cuentan como confusión.
        </p>
      ) : null}
    </section>
  )
}

interface CategoryRow {
  id: string
  name: string
  group?: string
  gpt?: CategoryScore
  jev?: CategoryScore
}

/** Categories of both lanes merged by id (GPT order first, then the ones only Jev has). */
function mergeCategories(gpt: LaneMetrics | null, jev: LaneMetrics | null): CategoryRow[] {
  const rows = new Map<string, CategoryRow>()
  for (const e of ENGINE_IDS) {
    for (const c of (e === 'gpt' ? gpt : jev)?.score.perCategory ?? []) {
      const row = rows.get(c.id) ?? { id: c.id, name: c.name, group: c.group }
      row[e] = c
      rows.set(c.id, row)
    }
  }
  return [...rows.values()]
}

function betterEngine(row: CategoryRow): EngineId | null {
  const g = row.gpt?.f1
  const j = row.jev?.f1
  if (g === null || g === undefined || j === null || j === undefined || Math.abs(g - j) < 1e-9) return null
  return g > j ? 'gpt' : 'jev'
}

function CategoryTable({ gpt, jev }: { gpt: LaneMetrics | null; jev: LaneMetrics | null }) {
  const all = useMemo(() => mergeCategories(gpt, jev), [gpt, jev])
  // Categories with no expected concepts and no predictions in either lane say nothing.
  const rows = all.filter((r) => ENGINE_IDS.some((e) => (r[e]?.support ?? 0) + (r[e]?.predicted ?? 0) > 0))
  const hidden = all.length - rows.length

  if (rows.length === 0) {
    return <p className={clsx(UI.card, UI.cardPadding, UI.muted, 'text-sm')}>Aún no hay clasificaciones para calcular precisión y recall.</p>
  }
  return (
    <div className="space-y-1.5">
      <div className={clsx(UI.card, 'relative max-h-[70vh] overflow-auto')}>
        <table className="w-full min-w-180 text-left text-sm">
          <thead className={UI.muted}>
            <tr>
              <th scope="col" className={clsx(TH, 'text-left')}>
                Categoría
              </th>
              <th scope="col" className={clsx(TH, 'text-right')} title="Conceptos esperados en esta categoría (si difiere entre carriles: GPT / Jev)">
                Soporte
              </th>
              {ENGINE_IDS.map((e) => (
                <Fragment key={e}>
                  <th scope="col" className={clsx(TH, 'text-right', ENGINE_THEME[e].text)} title="Aciertos / veces que el motor eligió la categoría">
                    {ENGINE_THEME[e].label} · prec.
                  </th>
                  <th scope="col" className={clsx(TH, 'text-right', ENGINE_THEME[e].text)} title="Aciertos / conceptos esperados en la categoría">
                    {ENGINE_THEME[e].label} · recall
                  </th>
                  <th scope="col" className={clsx(TH, 'text-right', ENGINE_THEME[e].text)} title="Media armónica de precisión y recall">
                    {ENGINE_THEME[e].label} · F1
                  </th>
                </Fragment>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
            {rows.map((row) => {
              const better = betterEngine(row)
              const sg = row.gpt?.support ?? 0
              const sj = row.jev?.support ?? 0
              return (
                <tr key={row.id} className="align-top">
                  <td className="px-3 py-2">
                    <div className="min-w-44">
                      <CategoryLabel id={row.id} name={row.name} />
                      {row.group ? <div className={clsx(UI.muted, 'text-xs')}>{row.group}</div> : null}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums" title={sg === sj ? undefined : `GPT: ${sg} · Jev: ${sj}`}>
                    {sg === sj ? int(sg) : `${int(sg)} / ${int(sj)}`}
                  </td>
                  {ENGINE_IDS.map((e) => {
                    const c = row[e]
                    const wins = better === e
                    return (
                      <Fragment key={e}>
                        <td className="px-3 py-2 text-right tabular-nums">{num(c?.precision, 2)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{num(c?.recall, 2)}</td>
                        <td className={clsx('px-3 py-2 text-right tabular-nums', wins && ['font-semibold', ENGINE_THEME[e].soft])}>
                          {num(c?.f1, 2)}
                          {wins ? <span className="sr-only"> (mejor F1)</span> : null}
                        </td>
                      </Fragment>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-zinc-300 font-medium dark:border-zinc-700">
              <th scope="row" colSpan={2} className="px-3 py-2 text-left">
                Macro-F1
              </th>
              {ENGINE_IDS.map((e) => (
                <Fragment key={e}>
                  <td />
                  <td />
                  <td className={clsx('px-3 py-2 text-right tabular-nums', ENGINE_THEME[e].text)}>{num((e === 'gpt' ? gpt : jev)?.score.macroF1, 3)}</td>
                </Fragment>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
      <p className={clsx(UI.muted, 'text-xs')}>
        Precisión = aciertos / veces que el motor eligió la categoría; recall = aciertos / conceptos esperados en ella. Una respuesta inválida, un error o un timeout cuenta
        como fallo del recall. En negrita, el mejor F1 de la fila.
        {hidden > 0 ? ` ${hidden} ${hidden === 1 ? 'categoría' : 'categorías'} sin conceptos ni predicciones omitidas.` : ''}
      </p>
    </div>
  )
}

export default function ConfusionsPanel() {
  const gpt = useLaneMetrics('gpt')
  const jev = useLaneMetrics('jev')
  return (
    <div className="space-y-5">
      <div className="grid gap-4 lg:grid-cols-2">
        <TopConfusions engine="gpt" metrics={gpt} />
        <TopConfusions engine="jev" metrics={jev} />
      </div>
      <div>
        <h4 className="mb-2 text-sm font-semibold">Precisión, recall y F1 por categoría</h4>
        <CategoryTable gpt={gpt} jev={jev} />
      </div>
    </div>
  )
}
