/**
 * Live smoke test (real API calls; a few items cost a fraction of a cent).
 *
 *   npm run smoke -- --n 5 --engine both|gpt|jev [--gpt-model X] [--jev-model Y] [--concurrency 2] [--dataset id]
 *
 * Uses the adapters directly (no HTTP) on the first N items of a seed dataset. Fairness: the adapters
 * only receive `toConceptInput(item)` (no label); the expected category is compared locally. Each
 * engine runs as its own lane with the same concurrency, both lanes starting at the same time.
 * Engines without a key are skipped with a warning; with no live engine at all it exits with code 1.
 * Never prints API keys.
 */
import path from 'node:path'
import { parseArgs } from 'node:util'
import dotenv from 'dotenv'
import { CONCURRENCY_OPTIONS, ENGINE_IDS, type ClassifyResult, type EngineId, type LabeledConcept } from '../src/shared/contracts.ts'
import { DEFAULT_DATASET_ID, SEED_DATASETS, getSeedDataset } from '../src/data/datasets.ts'
import { toConceptInput } from '../src/shared/task.ts'
import { redactSecrets, type EngineAdapter } from './adapters/common.ts'
import { createAdapters } from './adapters/index.ts'
import { loadConfig } from './env.ts'

dotenv.config({ path: path.resolve(import.meta.dirname, '..', '.env'), quiet: true })

const USAGE = `Uso: npm run smoke -- [--n 5] [--engine both|gpt|jev] [--gpt-model X] [--jev-model Y] [--concurrency 1|2|3] [--dataset id]
  --n            cantidad de conceptos del dataset (por defecto 5)
  --engine       motores a probar (por defecto both)
  --gpt-model    modelo de GPT (por defecto OPENAI_MODEL del .env)
  --jev-model    modelo de Jev (por defecto JEV_MODEL del .env)
  --concurrency  requests simultáneas por motor (1-3, por defecto 2)
  --dataset      id del dataset semilla (por defecto ${DEFAULT_DATASET_ID})`

interface Options {
  n: number
  engines: EngineId[]
  models: Partial<Record<EngineId, string>>
  concurrency: number
  datasetId: string
}

function fail(message: string): never {
  console.error(`${message}\n\n${USAGE}`)
  process.exit(2)
}

function parseOptions(argv: string[]): Options {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        n: { type: 'string', default: '5' },
        engine: { type: 'string', default: 'both' },
        'gpt-model': { type: 'string' },
        'jev-model': { type: 'string' },
        concurrency: { type: 'string', default: '2' },
        dataset: { type: 'string', default: DEFAULT_DATASET_ID },
        help: { type: 'boolean', short: 'h' },
      },
    }))
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
  if (values.help) {
    console.log(USAGE)
    process.exit(0)
  }
  const n = Number(values.n)
  if (!Number.isInteger(n) || n < 1) fail('--n debe ser un entero ≥ 1.')
  const concurrency = Number(values.concurrency)
  if (!(CONCURRENCY_OPTIONS as readonly number[]).includes(concurrency)) {
    fail(`--concurrency debe ser ${CONCURRENCY_OPTIONS.join(', ')}.`)
  }
  const engine = values.engine
  if (engine !== 'both' && engine !== 'gpt' && engine !== 'jev') fail('--engine debe ser both, gpt o jev.')
  const models: Options['models'] = {}
  if (values['gpt-model']) models.gpt = values['gpt-model']
  if (values['jev-model']) models.jev = values['jev-model']
  return { n, engines: engine === 'both' ? [...ENGINE_IDS] : [engine], models, concurrency, datasetId: values.dataset }
}

/** Runs `worker` over `items` with at most `limit` in flight; results keep the input order. */
async function pool<T, R>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await worker(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
  return results
}

interface Run {
  result: ClassifyResult
  /** End-to-end latency measured around the adapter call, ms. */
  latencyMs: number
  correct: boolean
}

function percentile(sorted: readonly number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined
  const rank = (sorted.length - 1) * p
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

const pct = (value: number | undefined): string => (value === undefined ? '-' : `${Math.round(value * 100)}%`)
const ms = (value: number | undefined): string => (value === undefined ? '-' : `${Math.round(value)}ms`)

function renderTable(rows: string[][]): string {
  const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)))
  const line = (row: string[]) => row.map((cell, col) => cell.padEnd(widths[col])).join('  ').trimEnd()
  return [line(rows[0]), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.slice(1).map(line)].join('\n')
}

function cell(run: Run | undefined): string[] {
  if (!run) return ['-', '-', '-']
  const { result, latencyMs, correct } = run
  const predicted = result.status === 'ok' ? `${result.answer.categoryId} ${correct ? '✓' : '✗'}` : result.status.toUpperCase()
  return [predicted, pct(result.answer.confidence), ms(latencyMs)]
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const dataset = getSeedDataset(options.datasetId)
  if (!dataset) {
    return fail(`Dataset desconocido: "${options.datasetId}". Disponibles: ${SEED_DATASETS.map((d) => d.id).join(', ')}.`)
  }

  const config = loadConfig()
  const adapters = createAdapters(config)
  const secrets = [config.gpt.apiKey, config.jev.apiKey]
  const live = options.engines.filter((id) => adapters[id].live)
  for (const id of options.engines.filter((id) => !adapters[id].live)) {
    const envVar = id === 'gpt' ? 'OPENAI_API_KEY' : 'OPENCODE_API_KEY'
    console.warn(`⚠ ${id}: sin key (${envVar} no está en .env); se omite.`)
  }
  if (live.length === 0) {
    console.error('No hay ningún motor con API key: agrega OPENAI_API_KEY y/u OPENCODE_API_KEY al .env.')
    process.exit(1)
  }

  const items: LabeledConcept[] = dataset.items.slice(0, options.n)
  const modelOf = (id: EngineId): string => options.models[id] ?? adapters[id].model
  console.log(`Jev Classify Lab · smoke · dataset ${dataset.id} · ${items.length} conceptos · concurrencia ${options.concurrency} por motor`)
  console.log(live.map((id) => `${id}: ${modelOf(id)} vía ${adapters[id].provider}`).join(' | '))
  console.log('Los motores solo reciben el concepto (sin etiqueta); la comparación con la esperada es local.\n')

  // Provider timeouts are per attempt (CLASSIFY_TIMEOUT_MS); this bounds the whole call including retries.
  const callTimeoutMs = config.gpt.timeoutMs * (config.gpt.maxRetries + 1) + 5_000

  const runLane = async (id: EngineId, adapter: EngineAdapter): Promise<Run[]> =>
    pool(items, options.concurrency, async (item) => {
      const started = performance.now()
      const result = await adapter.classify(dataset.task, toConceptInput(item), {
        signal: AbortSignal.timeout(callTimeoutMs),
        model: options.models[id],
      })
      const latencyMs = performance.now() - started
      return { result, latencyMs, correct: result.status === 'ok' && result.answer.categoryId === item.expected }
    })

  const startedAll = performance.now()
  const lanes = await Promise.all(live.map((id) => runLane(id, adapters[id])))
  const wallMs = performance.now() - startedAll
  const runs = new Map<EngineId, Run[]>(live.map((id, i) => [id, lanes[i]]))

  // Per-item table.
  const header = ['#', 'esperado', ...live.flatMap((id) => [`${id} predicho`, `${id} conf`, `${id} lat`])]
  const body = items.map((item, i) => [
    String(i + 1),
    item.expected,
    ...live.flatMap((id) => cell(runs.get(id)?.[i])),
  ])
  console.log(renderTable([header, ...body]))

  // Errors, one line per failed call (messages are redacted before printing).
  for (const id of live) {
    items.forEach((_item, i) => {
      const result = runs.get(id)?.[i].result
      if (result && result.status !== 'ok') {
        console.log(`  ⚠ ${id} #${i + 1} ${result.status}: ${redactSecrets(result.errorMessage ?? 'sin detalle', secrets)}`)
      }
    })
  }

  // Summary per engine.
  console.log('\nResumen')
  const summary: string[][] = [['motor', 'modelo', 'acierto', 'válidas', 'lat p50', 'lat p90', 'prov p50', 'tokens in/out', 'costo USD']]
  let anyEngineAllFailed = false
  for (const id of live) {
    const list = runs.get(id) ?? []
    const okRuns = list.filter((r) => r.result.status === 'ok')
    if (okRuns.length === 0) anyEngineAllFailed = true
    const e2e = list.map((r) => r.latencyMs).sort((a, b) => a - b)
    const provider = list
      .map((r) => r.result.providerLatencyMs)
      .filter((v): v is number => v !== undefined)
      .sort((a, b) => a - b)
    const usages = list.map((r) => r.result.usage).filter((u) => u !== undefined)
    const tokens = usages.length > 0 ? `${usages.reduce((s, u) => s + u.inputTokens, 0)}/${usages.reduce((s, u) => s + u.outputTokens, 0)}` : '-'
    const costs = list.map((r) => r.result.costUsd).filter((v): v is number => v !== undefined)
    const cost = costs.length > 0 ? costs.reduce((s, v) => s + v, 0).toFixed(6) : '-'
    const model = okRuns[0]?.result.model ?? list[0]?.result.model ?? modelOf(id)
    summary.push([
      id,
      model,
      `${list.filter((r) => r.correct).length}/${list.length} (${pct(list.filter((r) => r.correct).length / list.length)})`,
      `${okRuns.length}/${list.length}`,
      ms(percentile(e2e, 0.5)),
      ms(percentile(e2e, 0.9)),
      ms(percentile(provider, 0.5)),
      tokens,
      cost,
    ])
  }
  console.log(renderTable(summary))
  console.log(`\nTiempo total: ${ms(wallMs)}`)
  if (anyEngineAllFailed) {
    console.error('Al menos un motor no devolvió ninguna respuesta válida.')
    process.exitCode = 1
  }
}

main().catch((error: unknown) => {
  console.error('smoke falló:', redactSecrets(error instanceof Error ? error.message : String(error)))
  process.exitCode = 1
})
