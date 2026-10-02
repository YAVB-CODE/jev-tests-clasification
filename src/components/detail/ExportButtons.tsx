/** "Exportar JSON" / "Exportar CSV" buttons for the current run. */
import clsx from 'clsx'
import { useId, useState } from 'react'
import { useBench, type BenchRun } from '../../bench/useBench.ts'
import { useComparison, useLaneMetrics } from '../metrics/hooks.ts'
import { UI } from '../ui/theme.ts'
import { downloadExportCsv, downloadExportJson, type ExportInput } from './exporters.ts'

export default function ExportButtons({ run }: { run: BenchRun }) {
  const gptRecords = useBench((s) => s.lanes.gpt.records)
  const jevRecords = useBench((s) => s.lanes.jev.records)
  const gpt = useLaneMetrics('gpt')
  const jev = useLaneMetrics('jev')
  const comparison = useComparison()
  const [includeRaw, setIncludeRaw] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const rawId = useId()

  const empty = gptRecords.length + jevRecords.length === 0 || !gpt || !jev
  const invalid = comparison !== null && !comparison.validity.validForComparison

  const build = (): ExportInput | null =>
    gpt && jev ? { run, metrics: { gpt, jev }, comparison, records: { gpt: gptRecords, jev: jevRecords } } : null

  const exportAs = (kind: 'json' | 'csv') => {
    const input = build()
    if (!input) return
    try {
      setError(null)
      if (kind === 'json') downloadExportJson(input, { includeRaw })
      else downloadExportCsv(input)
    } catch (e) {
      setError(`No se pudo exportar: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={UI.button}
          disabled={empty}
          onClick={() => exportAs('json')}
          title="Configuración, métricas, comparación y todos los registros"
        >
          Exportar JSON
        </button>
        <button type="button" className={UI.button} disabled={empty} onClick={() => exportAs('csv')} title="Una fila por clasificación (GPT y Jev), listo para Excel">
          Exportar CSV
        </button>
        <label htmlFor={rawId} className={clsx(UI.muted, 'inline-flex items-center gap-1.5 text-sm')} title="Quita raw.request y raw.response del JSON para que pese menos">
          <input id={rawId} type="checkbox" checked={includeRaw} onChange={(e) => setIncludeRaw(e.target.checked)} />
          Incluir datos crudos en el JSON
        </label>
      </div>
      {invalid ? (
        <p className={clsx(UI.muted, 'text-xs')} title={comparison.validity.warnings.join('\n')}>
          Esta corrida no es válida para comparar: el JSON la marca con validForComparison = false.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-rose-700 dark:text-rose-400">
          {error}
        </p>
      ) : null}
    </div>
  )
}
