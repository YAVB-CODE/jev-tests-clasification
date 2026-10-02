/**
 * «Detalle» tab: per-concept table (GPT vs Jev vs expected), confusions per engine and per category,
 * and JSON / CSV export of the run. Reads the run snapshot (`run`), never the active dataset.
 */
import clsx from 'clsx'
import { useBench } from '../../bench/useBench.ts'
import { UI } from '../ui/theme.ts'
import ConceptsTable from './ConceptsTable.tsx'
import ConfusionsPanel from './ConfusionsPanel.tsx'
import ExportButtons from './ExportButtons.tsx'

export default function DetailView() {
  const run = useBench((s) => s.run)

  if (!run) {
    return (
      <section className={clsx(UI.card, UI.cardPadding, 'text-center')}>
        <h2 className="text-base font-semibold">Detalle por concepto</h2>
        <p className={clsx(UI.muted, 'mt-1 text-sm')}>
          Aún no hay una corrida. Inicia una desde la barra de control para ver cada concepto con la respuesta de GPT y de Jev, las confusiones y exportar los resultados.
        </p>
      </section>
    )
  }

  return (
    <div className="space-y-8">
      <section aria-labelledby="detail-concepts" className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="detail-concepts" className="text-base font-semibold">
              Detalle por concepto
            </h2>
            <p className={clsx(UI.muted, 'text-sm')}>
              {run.datasetName}. Expande una fila para ver la justificación, las probabilidades, los intentos y los payloads crudos.
            </p>
          </div>
          <ExportButtons run={run} />
        </div>
        <ConceptsTable run={run} />
      </section>

      <section aria-labelledby="detail-confusions" className="space-y-3">
        <h2 id="detail-confusions" className="text-base font-semibold">
          Confusiones
        </h2>
        <ConfusionsPanel />
      </section>
    </div>
  )
}
