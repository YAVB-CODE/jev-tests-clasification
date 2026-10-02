/** Expanded content of a detail row: dataset rationale, and per engine the full record (probabilities, usage, attempts, raw payloads). */
import clsx from 'clsx'
import { useMemo, useState, type ReactNode } from 'react'
import { ENGINE_IDS, type ClassificationRecord, type EngineId } from '../../shared/contracts.ts'
import { int, ms, num, pct, usd } from '../../metrics/format.ts'
import { ENGINE_THEME, UI } from '../ui/theme.ts'
import { STATUS_LABELS, outcomeOf, type DetailRow } from './detailRows.ts'
import { CategoryLabel, DifficultyBadge, OutcomeIcon } from './parts.tsx'

/** Probabilities shown per engine (the expected category is added when it falls outside). */
const TOP_PROBABILITIES = 5

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Collapsible JSON block; the text is only built once opened. */
function RawBlock({ label, value }: { label: string; value: unknown }) {
  const [open, setOpen] = useState(false)
  const text = useMemo(() => (open ? safeStringify(value) : ''), [open, value])
  return (
    <details
      onToggle={(e) => setOpen(e.currentTarget.open)}
      className="rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-950/50"
    >
      <summary className="cursor-pointer select-none px-2 py-1 text-xs font-medium">{label}</summary>
      {open ? (
        <pre className="max-h-64 overflow-auto border-t border-zinc-200 px-2 py-1.5 font-mono text-xs leading-snug whitespace-pre dark:border-zinc-800">
          {text}
        </pre>
      ) : null}
    </details>
  )
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className={clsx(UI.muted, 'shrink-0')} title={hint}>
        {label}
      </dt>
      <dd className="min-w-0 text-right tabular-nums">{children}</dd>
    </div>
  )
}

function nativeConfidenceField(record: ClassificationRecord): { label: string; hint: string; value: string } | null {
  const value = record.nativeConfidence
  if (value === undefined) return null
  if (record.nativeConfidenceKind === 'logprob') {
    return {
      label: 'Confianza nativa (logprobs)',
      hint: 'Probabilidad derivada de los logprobs de los tokens de la categoría elegida. Solo informativa: no se compara entre motores.',
      value: pct(value, 1),
    }
  }
  if (record.nativeConfidenceKind === 'jev_confidence') {
    return {
      label: 'Confianza nativa (Jev)',
      hint: 'Estadístico `confidence` de la respuesta Choice de Jev: no es una probabilidad. Solo informativa: no se compara entre motores.',
      value: num(value, 3),
    }
  }
  return { label: 'Confianza nativa', hint: 'Señal secundaria del motor, solo informativa.', value: num(value, 3) }
}

function Probabilities({
  record,
  engine,
  names,
}: {
  record: ClassificationRecord
  engine: EngineId
  names: ReadonlyMap<string, string>
}) {
  const entries = Object.entries(record.probabilities ?? {})
    .filter(([, p]) => Number.isFinite(p))
    .sort((a, b) => b[1] - a[1])
  if (entries.length === 0) return null
  const top = entries.slice(0, TOP_PROBABILITIES)
  const expected = entries.find(([id]) => id === record.expected)
  const shown = expected && !top.some(([id]) => id === record.expected) ? [...top, expected] : top
  return (
    <div>
      <h5 className={clsx(UI.label, 'mb-1')}>Probabilidades (top {Math.min(TOP_PROBABILITIES, entries.length)})</h5>
      <ul className="space-y-1.5">
        {shown.map(([id, p]) => (
          <li key={id}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="min-w-0 text-sm">
                <CategoryLabel id={id} name={names.get(id)} />
                {id === record.predicted ? <span className="ml-1.5 text-xs font-medium">· elegida</span> : null}
                {id === record.expected ? <span className="ml-1.5 text-xs font-medium">· esperada</span> : null}
              </span>
              <span className="shrink-0 text-xs tabular-nums">{pct(p, 1)}</span>
            </div>
            <div className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800" aria-hidden="true">
              <div className={clsx('h-full rounded-full', ENGINE_THEME[engine].solid)} style={{ width: `${Math.max(0, Math.min(1, p)) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

function EngineDetail({ engine, record, names }: { engine: EngineId; record: ClassificationRecord | undefined; names: ReadonlyMap<string, string> }) {
  const theme = ENGINE_THEME[engine]
  const header = (
    <header className={clsx('flex flex-wrap items-center gap-x-2 gap-y-1 rounded-t-lg px-3 py-2', theme.soft)}>
      <h4 className={clsx('text-sm font-semibold', theme.text)}>{theme.label}</h4>
      {record ? <span className="min-w-0 truncate font-mono text-xs">{record.model}</span> : null}
      {record?.mode === 'mock' ? (
        <span className={clsx(UI.badge, 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300')}>SIMULADO</span>
      ) : null}
    </header>
  )

  if (!record) {
    return (
      <section className={clsx('rounded-lg border', theme.border)}>
        {header}
        <p className={clsx(UI.muted, 'px-3 py-3 text-sm')}>Este concepto aún no tiene resultado en este carril.</p>
      </section>
    )
  }

  const outcome = outcomeOf(record)
  const native = nativeConfidenceField(record)
  const attempts = record.attempts ?? []
  const raw = record.raw
  const hasRaw = raw?.request !== undefined || raw?.response !== undefined
  return (
    <section className={clsx('min-w-0 rounded-lg border', theme.border)}>
      {header}
      <div className="space-y-3 px-3 py-3">
        <div className="flex items-start gap-2">
          <OutcomeIcon outcome={outcome} className="mt-0.5" />
          <div className="min-w-0 text-sm">
            {record.predicted ? (
              <CategoryLabel id={record.predicted} name={names.get(record.predicted)} />
            ) : (
              <span className="font-medium">Sin categoría</span>
            )}
            <div className={clsx(UI.muted, 'text-xs')}>
              {STATUS_LABELS[record.status]}
              {outcome === 'wrong' ? ' · distinta de la esperada' : ''}
              {outcome === 'correct' ? ' · coincide con la esperada' : ''}
            </div>
          </div>
        </div>

        {record.errorMessage ? (
          <p role="alert" className="rounded-md bg-amber-50 px-2 py-1.5 text-sm break-words text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            {record.errorMessage}
          </p>
        ) : null}

        <dl className="space-y-1">
          <Field
            label="Confianza"
            hint={engine === 'gpt' ? 'Autodeclarada por el modelo en su JSON.' : 'Probabilidad que Jev asigna a la categoría elegida.'}
          >
            {record.confidence !== undefined ? pct(record.confidence, 1) : '—'}
          </Field>
          {native ? (
            <Field label={native.label} hint={native.hint}>
              {native.value}
            </Field>
          ) : null}
          <Field label="Latencia extremo a extremo">{ms(record.latencyMs)}</Field>
          {record.providerLatencyMs !== undefined ? <Field label="Latencia del proveedor">{ms(record.providerLatencyMs)}</Field> : null}
          <Field label="Tokens" hint={record.estimated ? 'Estimados (motor simulado).' : undefined}>
            {record.usage ? `${int(record.usage.inputTokens)} entrada · ${int(record.usage.outputTokens)} salida` : '—'}
          </Field>
          <Field label="Costo" hint={record.estimated ? 'Estimado (motor simulado).' : undefined}>
            {record.costUsd !== undefined ? usd(record.costUsd) : '—'}
            {record.estimated && record.costUsd !== undefined ? ' (est.)' : ''}
          </Field>
          <Field label="Intentos HTTP">{attempts.length > 0 ? attempts.length : '—'}</Field>
        </dl>

        {attempts.length > 0 ? (
          <ul className="space-y-0.5 rounded-md bg-zinc-50 px-2 py-1.5 text-xs dark:bg-zinc-950/50">
            {attempts.map((a) => (
              <li key={a.attempt} className="break-words tabular-nums">
                <span className="font-medium">#{a.attempt}</span> · {a.status === null ? 'sin respuesta HTTP' : `HTTP ${a.status}`} · {ms(a.ms)}
                {a.error ? <span className={UI.muted}> · {a.error}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}

        <Probabilities record={record} engine={engine} names={names} />

        <div className="space-y-1.5">
          {raw?.request !== undefined ? <RawBlock label="raw.request" value={raw.request} /> : null}
          {raw?.response !== undefined ? <RawBlock label="raw.response" value={raw.response} /> : null}
          {!hasRaw ? <p className={clsx(UI.muted, 'text-xs')}>Sin payload crudo para este registro.</p> : null}
        </div>
      </div>
    </section>
  )
}

export interface RowDetailProps {
  row: DetailRow
  names: ReadonlyMap<string, string>
}

export default function RowDetail({ row, names }: RowDetailProps) {
  const { item } = row
  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <section className="min-w-0">
          <h4 className={clsx(UI.label, 'mb-1')}>Concepto</h4>
          <p className="text-sm break-words">{item.concept}</p>
          <p className={clsx(UI.muted, 'mt-1 text-xs break-words')}>
            {[
              item.supplier ? `Proveedor: ${item.supplier}` : null,
              item.amount !== undefined ? `Valor: ${int(item.amount)}${item.currency ? ` ${item.currency}` : ''}` : null,
              item.notes ? `Notas: ${item.notes}` : null,
            ]
              .filter(Boolean)
              .join(' · ') || 'Sin proveedor ni valor.'}
          </p>
          <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className={UI.muted}>Esperado:</span>
            <CategoryLabel id={item.expected} name={names.get(item.expected)} />
            <DifficultyBadge difficulty={item.difficulty} />
          </p>
        </section>
        <section className="min-w-0 rounded-md bg-zinc-50 p-3 dark:bg-zinc-950/50">
          <h4 className={clsx(UI.label, 'mb-1')}>Justificación del dataset</h4>
          <p className="text-sm break-words">{item.rationale || 'El dataset no trae justificación para este concepto.'}</p>
          <p className={clsx(UI.muted, 'mt-1.5 text-xs')}>Solo para ti: la etiqueta y esta justificación nunca se enviaron a los modelos.</p>
        </section>
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        {ENGINE_IDS.map((e) => (
          <EngineDetail key={e} engine={e} record={row.records[e]} names={names} />
        ))}
      </div>
    </div>
  )
}
