/** One lane of the quick-test result (GPT left, Jev right): answer, confidence, probabilities, latency, tokens, cost, errors. */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { Category, Dataset, EngineId } from '../../shared/contracts.ts'
import type { QuickLane } from '../../bench/useBench.ts'
import { MODE_LABELS } from '../../engines/labels.ts'
import { int, ms, num, pct, usd } from '../../metrics/format.ts'
import { ENGINE_THEME, OUTCOME_STYLE, UI } from '../ui/theme.ts'
import {
  CONFIDENCE_NOTE,
  NATIVE_CONFIDENCE,
  STATUS_LABEL,
  topProbabilities,
  type Judgement,
} from './quickUtils.ts'

interface Props {
  engine: EngineId
  lane: QuickLane
  /** Dataset whose task produced the result (category names); undefined if it was deleted. */
  dataset: Dataset | undefined
  /** Expected answer picked locally ('' = none); only used to print its label next to a miss. */
  expected: string
  /** ✓ / ✗ / ! against the expected answer; null when no expected answer applies. */
  judgement: Judgement | null
}

function categoryOf(dataset: Dataset | undefined, id: string): Category | undefined {
  return dataset?.task.categories.find((c) => c.id === id)
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={UI.label}>{label}</dt>
      <dd className="mt-0.5 text-sm tabular-nums">{children}</dd>
    </div>
  )
}

function ConfidenceBar({ engine, value }: { engine: EngineId; value: number }) {
  const clamped = Math.min(1, Math.max(0, value))
  return (
    <div className="flex items-center gap-3">
      <div
        role="meter"
        aria-label="Confianza"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(clamped * 100)}
        aria-valuetext={pct(clamped)}
        className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800"
      >
        <div className={clsx('h-full rounded-full', ENGINE_THEME[engine].solid)} style={{ width: `${clamped * 100}%` }} />
      </div>
      <span className="min-w-14 shrink-0 whitespace-nowrap text-right text-sm font-semibold tabular-nums">{pct(clamped)}</span>
    </div>
  )
}

export default function QuickLaneCard({ engine, lane, dataset, expected, judgement }: Props) {
  const theme = ENGINE_THEME[engine]
  const result = lane.result
  const mode = result?.mode ?? lane.mode
  const model = result?.model ?? lane.model
  const answer = result?.answer
  const categoryId = answer?.categoryId ?? null
  const category = categoryId !== null ? categoryOf(dataset, categoryId) : undefined
  const ranked = topProbabilities(answer?.probabilities, 5)
  const nativeValue = answer?.nativeConfidence
  const nativeKind = answer?.nativeConfidenceKind
  const expectedCategory = expected !== '' ? categoryOf(dataset, expected) : undefined

  return (
    <article
      aria-labelledby={`quick-lane-${engine}`}
      aria-busy={lane.status === 'running'}
      className={clsx(UI.card, 'overflow-hidden border-2', theme.border)}
    >
      <header className={clsx('flex flex-wrap items-start justify-between gap-2 px-4 py-3', theme.soft)}>
        <div className="min-w-0">
          <h3 id={`quick-lane-${engine}`} className={clsx('text-lg font-semibold', theme.text)}>
            {theme.label}
          </h3>
          <p className={clsx('text-xs', UI.muted)}>{theme.vendor}</p>
        </div>
        <div className="min-w-0 text-right">
          <span
            className={clsx(
              UI.badge,
              mode === 'mock' ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300' : 'bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200',
            )}
          >
            {mode === 'mock' ? 'Simulado' : 'Live'}
          </span>
          <p className={clsx('mt-0.5 break-all text-xs', UI.muted)} title={`Modo ${MODE_LABELS[mode]}`}>
            {model}
          </p>
        </div>
      </header>

      <div className="space-y-4 p-4">
        {lane.status === 'idle' ? <p className={clsx('text-sm', UI.muted)}>Sin resultado todavía: escribe un concepto y pulsa «Clasificar con ambos».</p> : null}

        {lane.status === 'running' ? (
          <div role="status" className="space-y-2">
            <p className={clsx('text-sm font-medium', theme.text)}>Clasificando…</p>
            <div className="h-2.5 rounded-full bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-800" />
            <div className="h-2.5 w-2/3 rounded-full bg-zinc-100 motion-safe:animate-pulse dark:bg-zinc-800" />
          </div>
        ) : null}

        {lane.status === 'done' && result !== undefined ? (
          <>
            {result.status !== 'ok' ? (
              <div role="alert" className={clsx('rounded-lg px-3 py-2 text-sm', OUTCOME_STYLE.failed.soft, OUTCOME_STYLE.failed.text)}>
                <p className="font-semibold">
                  <span aria-hidden="true">{OUTCOME_STYLE.failed.icon} </span>
                  {STATUS_LABEL[result.status]}
                </p>
                {result.errorMessage ? <p className="mt-0.5 break-words">{result.errorMessage}</p> : null}
              </div>
            ) : null}

            <div>
              <p className={UI.label}>Categoría elegida</p>
              {categoryId !== null ? (
                <div className="mt-1">
                  <p className="text-xl font-semibold leading-snug">
                    <span className="font-mono">{categoryId}</span>
                    {category ? <span> · {category.name}</span> : null}
                  </p>
                  <p className={clsx('text-sm', UI.muted)}>{category?.group ? `Grupo: ${category.group}` : category ? 'Sin grupo' : 'Categoría fuera del dataset actual'}</p>
                </div>
              ) : (
                <p className={clsx('mt-1 text-sm', UI.muted)}>Sin categoría: el motor no dio una respuesta válida.</p>
              )}
              {judgement !== null ? (
                <p
                  className={clsx('mt-2 inline-block rounded-md px-2 py-1 text-sm font-semibold', OUTCOME_STYLE[judgement].soft, OUTCOME_STYLE[judgement].text)}
                >
                  <span aria-hidden="true">{OUTCOME_STYLE[judgement].icon} </span>
                  {OUTCOME_STYLE[judgement].label}
                  {judgement !== 'correct' ? (
                    <span className="font-normal">
                      {' '}
                      · esperada: <span className="font-mono">{expected}</span>
                      {expectedCategory ? ` ${expectedCategory.name}` : ''}
                    </span>
                  ) : null}
                </p>
              ) : null}
            </div>

            <div>
              <p className={UI.label}>Confianza</p>
              {answer?.confidence !== undefined ? (
                <div className="mt-1.5">
                  <ConfidenceBar engine={engine} value={answer.confidence} />
                </div>
              ) : (
                <p className={clsx('mt-1 text-sm', UI.muted)}>El motor no devolvió una confianza.</p>
              )}
              <p className={clsx('mt-1 text-xs', UI.muted)}>{CONFIDENCE_NOTE[engine]}</p>
            </div>

            {ranked.length > 0 ? (
              <div>
                <p className={UI.label}>Top {ranked.length} de probabilidades</p>
                <ol className="mt-1.5 space-y-1.5">
                  {ranked.map(({ id, p }) => {
                    const chosen = id === categoryId
                    const name = categoryOf(dataset, id)?.name
                    return (
                      <li key={id} className="text-xs">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className={clsx('min-w-0 truncate', chosen && 'font-semibold')} title={name ? `${id} · ${name}` : id}>
                            <span className="font-mono">{id}</span>
                            {name ? ` · ${name}` : ''}
                            {chosen ? <span className="sr-only"> (elegida)</span> : null}
                          </span>
                          <span className="shrink-0 tabular-nums">{pct(p)}</span>
                        </div>
                        <div aria-hidden="true" className="mt-0.5 h-1.5 overflow-hidden rounded-full bg-zinc-100 dark:bg-zinc-800">
                          <div className={clsx('h-full rounded-full', chosen ? theme.solid : 'bg-zinc-400 dark:bg-zinc-500')} style={{ width: `${Math.min(1, Math.max(0, p)) * 100}%` }} />
                        </div>
                      </li>
                    )
                  })}
                </ol>
              </div>
            ) : null}

            {nativeValue !== undefined && nativeKind !== undefined ? (
              <div>
                <p className={UI.label}>Confianza nativa</p>
                <p className="mt-1 text-sm">
                  <span className="font-semibold tabular-nums">{nativeKind === 'logprob' ? pct(nativeValue) : num(nativeValue, 3)}</span>{' '}
                  <code className="rounded bg-zinc-100 px-1 py-0.5 text-xs dark:bg-zinc-800">{NATIVE_CONFIDENCE[nativeKind].label}</code>
                </p>
                <p className={clsx('mt-0.5 text-xs', UI.muted)}>{NATIVE_CONFIDENCE[nativeKind].note}</p>
              </div>
            ) : null}

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-zinc-100 pt-3 dark:border-zinc-800">
              <Metric label="Latencia extremo a extremo">{ms(lane.latencyMs)}</Metric>
              <Metric label="Latencia del proveedor">{ms(result.providerLatencyMs)}</Metric>
              <Metric label="Tokens">
                {result.usage ? (
                  <>
                    {int(result.usage.inputTokens)} entrada · {int(result.usage.outputTokens)} salida
                  </>
                ) : (
                  '—'
                )}
              </Metric>
              <Metric label="Costo">
                {usd(result.costUsd)}
                {result.estimated ? <span className={clsx(UI.badge, 'ml-1.5 bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300')}>estimado</span> : null}
              </Metric>
              <Metric label="Modo">{mode === 'mock' ? 'Simulado' : 'Live'}</Metric>
              <Metric label="Intentos">{result.attempts ? int(result.attempts.length) : '—'}</Metric>
            </dl>

            {result.raw ? (
              <details className="text-xs">
                <summary className="cursor-pointer rounded font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-500">
                  Ver request y respuesta crudas
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-zinc-200 bg-zinc-50 p-2 font-mono text-[11px] dark:border-zinc-800 dark:bg-zinc-950/50">
                  {JSON.stringify(result.raw, null, 2)}
                </pre>
              </details>
            ) : null}
          </>
        ) : null}
      </div>
    </article>
  )
}
