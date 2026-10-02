import type { ReactNode } from 'react'
import { DASH, int, ms, num, pct, usd } from '../../metrics/index.ts'
import type { ClassificationRecord, LabeledConcept } from '../../shared/contracts.ts'
import { DIFFICULTY_LABELS } from '../layout/labels.ts'
import {
  NATIVE_CONFIDENCE_TEXT,
  STATUS_TEXT,
  categoryText,
  clampConfidence,
  topProbabilities,
  type CategoryIndex,
} from './laneView.ts'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  )
}

/** Expanded detail of one classification: probabilities, native confidence, error and the dataset's rationale. */
export function FeedDetail({
  id,
  record,
  item,
  categories,
}: {
  id: string
  record: ClassificationRecord
  item: LabeledConcept | undefined
  categories: CategoryIndex
}) {
  const top = topProbabilities(record.probabilities, 3)
  const confidence = clampConfidence(record.confidence)
  const money = record.costUsd !== undefined ? usd(record.costUsd) : undefined
  const meta = [
    item?.supplier ? `Proveedor: ${item.supplier}` : null,
    item?.amount !== undefined ? `Valor: ${int(item.amount)}${item.currency ? ` ${item.currency}` : ''}` : null,
    item?.notes ? `Notas: ${item.notes}` : null,
  ].filter((part): part is string => part !== null)

  return (
    <div id={id} className="space-y-2 border-t border-zinc-100 bg-zinc-50 px-3 py-2.5 text-xs dark:border-zinc-800 dark:bg-zinc-950/50">
      <p className="break-words text-[13px]">{item?.concept ?? record.itemId}</p>
      {meta.length > 0 && <p className="break-words text-zinc-500 dark:text-zinc-400">{meta.join(' · ')}</p>}

      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1">
        <Row label="Predicho">{record.predicted !== null ? categoryText(categories, record.predicted) : 'Sin categoría'}</Row>
        <Row label="Esperado">{categoryText(categories, record.expected)}</Row>
        <Row label="Estado">
          {STATUS_TEXT[record.status]}
          {record.errorMessage ? <span className="text-amber-700 dark:text-amber-400"> · {record.errorMessage}</span> : null}
        </Row>
        <Row label="Confianza">
          {confidence !== undefined ? pct(confidence, 1) : 'no declarada'}
          {record.nativeConfidence !== undefined && (
            <span className="text-zinc-500 dark:text-zinc-400">
              {' '}
              · nativa {num(record.nativeConfidence)}
              {record.nativeConfidenceKind ? ` (${NATIVE_CONFIDENCE_TEXT[record.nativeConfidenceKind]})` : ''}
            </span>
          )}
        </Row>
        <Row label="Latencia">
          <span className="tabular-nums">
            {ms(record.latencyMs)}
            {record.providerLatencyMs !== undefined ? ` · proveedor ${ms(record.providerLatencyMs)}` : ''}
            {record.attempts && record.attempts.length > 1 ? ` · ${record.attempts.length} intentos` : ''}
          </span>
        </Row>
        {(record.usage || money) && (
          <Row label="Tokens / costo">
            <span className="tabular-nums">
              {record.usage ? `${int(record.usage.inputTokens)} / ${int(record.usage.outputTokens)}` : DASH}
              {money ? ` · ${money}` : ''}
              {record.estimated ? ' (estimado)' : ''}
            </span>
          </Row>
        )}
        <Row label="Item">
          <span className="tabular-nums">
            #{record.index + 1}
            {record.repetition > 0 ? ` · repetición ${record.repetition + 1}` : ''}
            {record.difficulty ? ` · ${DIFFICULTY_LABELS[record.difficulty]}` : ''}
          </span>
        </Row>
      </dl>

      {top.length > 0 && (
        <div>
          <p className="mb-1 text-zinc-500 dark:text-zinc-400">Probabilidades (top {top.length})</p>
          <ul className="space-y-1">
            {top.map(({ id: categoryId, p }) => (
              <li key={categoryId} className="grid grid-cols-[minmax(0,1fr)_6rem_2.75rem] items-center gap-2">
                <span className="truncate" title={categoryText(categories, categoryId)}>
                  {categoryText(categories, categoryId)}
                  {categoryId === record.expected ? <span className="text-zinc-500 dark:text-zinc-400"> (esperada)</span> : null}
                </span>
                <span className="h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                  <span className="block h-full rounded-full bg-zinc-500 dark:bg-zinc-400" style={{ width: `${p * 100}%` }} />
                </span>
                <span className="text-right tabular-nums">{pct(p, 1)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {item?.rationale && (
        <p className="break-words rounded-md bg-white px-2 py-1.5 text-zinc-600 ring-1 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800">
          <span className="font-medium text-zinc-900 dark:text-zinc-100">Justificación del dataset: </span>
          {item.rationale}
        </p>
      )}
    </div>
  )
}
