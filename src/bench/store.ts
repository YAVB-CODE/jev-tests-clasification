/**
 * Benchmark store (zustand vanilla). The React hook lives in `useBench.ts`.
 *
 * Invariants
 *  - Reactive state holds plain data only. The run's AbortController lives in this closure.
 *  - `start()` builds the plan ONCE and launches both lanes back to back, in the same tick, with
 *    the same plan, concurrency and timeout. Starting again aborts the previous run first.
 *  - Every run gets a new `runId`; events of any other run (aborted, stopped, superseded) are
 *    dropped, so late callbacks never touch new state (safe with React StrictMode).
 *  - Records are appended IMMUTABLY (new array per record): consumers can memoize on identity.
 *  - The run keeps a snapshot (`run`: task, plan, config, modes/models) — grade and show results
 *    against `run.task`, not the active dataset, which may be edited afterwards.
 */
import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  CONCURRENCY_OPTIONS,
  DEFAULT_BENCH_CONFIG,
  DIFFICULTIES,
  ENGINE_IDS,
  REPETITION_OPTIONS,
  type BenchConfig,
  type ClassificationRecord,
  type ClassificationTask,
  type ClassifyResult,
  type ConceptInput,
  type Dataset,
  type EngineId,
  type EngineMode,
  type HealthResponse,
  type LabeledConcept,
  type LaneRunInfo,
  type LaneStatus,
  type ModelsResponse,
} from '../shared/contracts.ts'
import { validateConceptInput, validateDataset, type ValidationResult } from '../shared/task.ts'
import { createEngine as defaultCreateEngine } from '../engines/index.ts'
import { fetchHealth as defaultFetchHealth, fetchModels as defaultFetchModels, type ModelsResult } from '../engines/api.ts'
import { ENGINE_NAMES, MODE_LABELS, SERVER_DEFAULT_MODEL } from '../engines/labels.ts'
import { MOCK_PROFILES } from '../engines/profiles.ts'
import type { Engine, Oracle } from '../engines/types.ts'
import { buildRunPlan, plannedKey, type PlannedItem } from './plan.ts'
import { hashSeed } from './rng.ts'
import { classifyOnce, clampTimeoutMs, runLane } from './runner.ts'

// ─────────────────────────────── Types ────────────────────────────────

/** Global run status (same values as a lane). */
export type BenchStatus = LaneStatus

export interface LaneState {
  engine: EngineId
  /** Mode for the NEXT run. The mode of the current / last run is `info.mode`. */
  mode: EngineMode
  /** Live model for the next run: user pick, else `models[e].default`, else `health.engines[e].model`. */
  model?: string
  /** Current / last run of this lane (mirrors `mode` / `model` while there is no run). */
  info: LaneRunInfo
  /** Graded records of the current / last run, in completion order (sort by `index` for queue order). */
  records: ClassificationRecord[]
}

/** Snapshot of what a run uses. */
export interface BenchRun {
  datasetId: string
  datasetName: string
  task: ClassificationTask
  /** Shared queue of both lanes (`PlannedItem.item` carries the label, `rationale`, difficulty). */
  plan: PlannedItem[]
  config: BenchConfig
  engines: Record<EngineId, { mode: EngineMode; model?: string }>
  /** epoch ms */
  startedAt: number
  /** epoch ms; set when both lanes ended (not changed by `rerunFailed`). */
  finishedAt?: number
}

export type QuickStatus = 'idle' | 'running' | 'done'

export interface QuickLane {
  engine: EngineId
  mode: EngineMode
  model: string
  status: QuickStatus
  result?: ClassifyResult
  /** End to end, in ms. */
  latencyMs?: number
}

/** Quick test: one unlabeled concept, both engines in parallel. */
export interface QuickState {
  status: QuickStatus
  /** Validated concept that was sent (id "prueba-rapida" unless one was given). */
  input: ConceptInput | null
  /** Dataset whose task (categories) was used. */
  datasetId: string | null
  /** Validation / precondition message (Spanish), or null. */
  error: string | null
  lanes: Record<EngineId, QuickLane>
}

/** Concept typed in the quick test (no id needed). */
export type QuickInput = Omit<ConceptInput, 'id'> & { id?: string }

export interface BenchState {
  config: BenchConfig
  /** Seed datasets first, then custom ones. */
  datasets: Dataset[]
  activeDatasetId: string
  lanes: Record<EngineId, LaneState>
  /** Last /api/health answer (null until loaded). `ok: false` = backend unreachable. */
  health: HealthResponse | null
  healthLoading: boolean
  /** Last successful /api/models answer (null until loaded). */
  models: ModelsResponse | null
  modelsLoading: boolean
  modelsError: string | null
  /** Id of the latest started run (start / rerunFailed); bumped by reset. */
  runId: number
  status: BenchStatus
  run: BenchRun | null
  /** Last start() precondition error (Spanish), or null. */
  error: string | null
  /** Set when custom datasets could not be saved in the browser (Spanish), or null. */
  storageWarning: string | null
  quick: QuickState

  /** Loads health and models once (idempotent, StrictMode-safe). */
  init(): Promise<void>
  /** Sanitized partial update. Ignored while running. `datasetId` behaves like `selectDataset`. */
  setConfig(patch: Partial<BenchConfig>): void
  /** Ignored while running or if the id is unknown. */
  selectDataset(id: string): void
  /** Validates, marks as custom and persists. Seed ids are rejected. */
  upsertCustomDataset(dataset: Dataset): ValidationResult<Dataset>
  /** Removes a custom dataset (persists). If it was active, falls back to the default dataset. */
  deleteCustomDataset(id: string): void
  /** 'live' is ignored unless `health.engines[e].live`. Ignored while running. */
  setLaneMode(engine: EngineId, mode: EngineMode): void
  /** undefined = back to the default model. Ignored while running. */
  setLaneModel(engine: EngineId, model: string | undefined): void
  refreshHealth(): Promise<void>
  refreshModels(force?: boolean): Promise<void>
  /** Builds the plan once and launches both lanes together (aborts any previous run). */
  start(): void
  /** Aborts the running run: lanes become 'aborted', partial records stay. */
  stop(): void
  /** Aborts and clears the run and its records (config, modes and models stay). */
  reset(): void
  /** Re-runs, per lane, only the records with status error / timeout / invalid, replacing them. */
  rerunFailed(): void
  /** Classifies one unlabeled concept with both engines (current modes / models, active task). */
  classifyQuick(input: QuickInput): Promise<void>
  /** Clears the quick test (cancels it if in flight). */
  clearQuick(): void
}

export interface EngineFactoryOptions {
  /** Run seed (mock determinism). */
  seed: number
  /** Label lookup for mocks (live engines ignore it). */
  oracle: Oracle
}

export type EngineFactory = (id: EngineId, mode: EngineMode, opts: EngineFactoryOptions) => Engine

export interface BenchStoreDeps {
  seedDatasets: readonly Dataset[]
  /** Defaults to the first seed dataset. */
  defaultDatasetId?: string
  /** Custom datasets persisted by the user. Defaults to none. */
  loadCustomDatasets?: () => Dataset[]
  /** Returns false when it could not persist (the datasets then live only in memory). */
  saveCustomDatasets?: (datasets: readonly Dataset[]) => boolean | void
  createEngine?: EngineFactory
  fetchHealth?: () => Promise<HealthResponse>
  fetchModels?: (refresh: boolean) => Promise<ModelsResult>
  /** epoch ms clock. */
  now?: () => number
  /** Monotonic clock for latencies. */
  perfNow?: () => number
}

// ─────────────────────────────── Helpers ────────────────────────────────

const FAILED_STATUSES: ReadonlySet<string> = new Set(['error', 'timeout', 'invalid'])
const QUICK_ITEM_ID = 'prueba-rapida'
const MAX_SEED = 2 ** 31 - 1

export function isFailedRecord(record: Pick<ClassificationRecord, 'status'>): boolean {
  return FAILED_STATUSES.has(record.status)
}

function mockModel(engine: EngineId): string {
  return MOCK_PROFILES[engine].model
}

function displayModel(engine: EngineId, mode: EngineMode, model: string | undefined): string {
  return mode === 'mock' ? mockModel(engine) : model || SERVER_DEFAULT_MODEL
}

function idleInfo(lane: Pick<LaneState, 'engine' | 'mode' | 'model'>): LaneRunInfo {
  return { engine: lane.engine, mode: lane.mode, model: displayModel(lane.engine, lane.mode, lane.model), status: 'idle', total: 0 }
}

function asSeed(dataset: Dataset): Dataset {
  return dataset.source === 'seed' ? dataset : { ...dataset, source: 'seed' }
}

function oracleFor(plan: readonly PlannedItem[]): Oracle {
  const byId = new Map<string, LabeledConcept>()
  for (const { item } of plan) byId.set(item.id, item)
  return (itemId) => byId.get(itemId)
}

/** Normalizes a config patch; invalid fields keep the previous value. */
export function sanitizeConfig(prev: BenchConfig, patch: Partial<BenchConfig>): BenchConfig {
  const next: BenchConfig = { ...prev }
  if ('difficulties' in patch) {
    const wanted = Array.isArray(patch.difficulties) ? patch.difficulties : []
    const list = DIFFICULTIES.filter((d) => wanted.includes(d))
    if (list.length > 0) next.difficulties = list
    else delete next.difficulties
  }
  if ('limit' in patch) {
    const limit = patch.limit
    if (typeof limit !== 'number') delete next.limit
    else if (Number.isFinite(limit) && limit >= 1) next.limit = Math.floor(limit)
  }
  if (typeof patch.shuffle === 'boolean') next.shuffle = patch.shuffle
  if (patch.seed !== undefined && Number.isFinite(patch.seed)) next.seed = Math.min(MAX_SEED, Math.max(0, Math.round(patch.seed)))
  if (patch.concurrency !== undefined && (CONCURRENCY_OPTIONS as readonly number[]).includes(patch.concurrency)) {
    next.concurrency = patch.concurrency
  }
  if (patch.repetitions !== undefined && (REPETITION_OPTIONS as readonly number[]).includes(patch.repetitions)) {
    next.repetitions = patch.repetitions
  }
  if (patch.timeoutMs !== undefined && Number.isFinite(patch.timeoutMs)) next.timeoutMs = clampTimeoutMs(patch.timeoutMs)
  return next
}

function emptyQuick(lanes: Record<EngineId, LaneState>): QuickState {
  const lane = (e: EngineId): QuickLane => ({
    engine: e,
    mode: lanes[e].mode,
    model: displayModel(e, lanes[e].mode, lanes[e].model),
    status: 'idle',
  })
  return { status: 'idle', input: null, datasetId: null, error: null, lanes: { gpt: lane('gpt'), jev: lane('jev') } }
}

// ─────────────────────────────── Store ────────────────────────────────

export function createBenchStore(deps: BenchStoreDeps): StoreApi<BenchState> {
  const now = deps.now ?? Date.now
  const perfNow = deps.perfNow ?? ((): number => performance.now())
  const createEngine: EngineFactory = deps.createEngine ?? ((id, mode, opts) => defaultCreateEngine(id, mode, opts))
  const fetchHealth = deps.fetchHealth ?? (() => defaultFetchHealth())
  const fetchModels = deps.fetchModels ?? ((refresh: boolean) => defaultFetchModels(refresh))
  const saveCustom = deps.saveCustomDatasets ?? (() => undefined)

  const seeds = deps.seedDatasets.map(asSeed)
  let customs: Dataset[] = []
  try {
    const seedIds = new Set(seeds.map((d) => d.id))
    customs = (deps.loadCustomDatasets?.() ?? [])
      .filter((d) => !seedIds.has(d.id))
      .map((d) => ({ ...d, source: 'custom' as const }))
  } catch {
    customs = []
  }
  const allDatasets = (): Dataset[] => [...seeds, ...customs]
  /** Persists the custom datasets; returns the warning to show, or null. */
  const persist = (): string | null => {
    let saved: boolean | void = false
    try {
      saved = saveCustom(customs)
    } catch {
      saved = false
    }
    return saved === false
      ? 'No se pudieron guardar los datasets en este navegador: los cambios se perderán al recargar.'
      : null
  }
  const defaultDatasetId = (): string => {
    const all = allDatasets()
    return all.find((d) => d.id === deps.defaultDatasetId)?.id ?? all[0]?.id ?? ''
  }

  /** Explicit user choices; defaults are re-derived from health / models. */
  const userModes: Partial<Record<EngineId, EngineMode>> = {}
  const userModels: Partial<Record<EngineId, string>> = {}

  /** The active run (start / rerun). null = nothing in flight. */
  let current: { runId: number; controller: AbortController; rerun: boolean } | null = null
  let quickToken = 0
  let quickController: AbortController | null = null
  let initPromise: Promise<void> | null = null

  const initialDatasetId = defaultDatasetId()
  const initialLanes = {} as Record<EngineId, LaneState>
  for (const e of ENGINE_IDS) {
    const lane = { engine: e, mode: 'mock' as EngineMode }
    initialLanes[e] = { ...lane, info: idleInfo(lane), records: [] }
  }

  return createStore<BenchState>()((set, get) => {
    const isRunning = (): boolean => get().status === 'running'
    const isActive = (runId: number): boolean => current !== null && current.runId === runId

    /** Re-derives lane mode / model from user choices + health + models. */
    const resolveLanes = (state: BenchState): Record<EngineId, LaneState> => {
      const lanes = { ...state.lanes }
      for (const e of ENGINE_IDS) {
        const live = state.health?.engines[e]?.live === true
        let mode = userModes[e] ?? (live ? 'live' : 'mock')
        if (mode === 'live' && !live) mode = 'mock'
        const listed = state.models?.[e]?.models
        const picked = userModels[e]
        if (picked !== undefined && listed !== undefined && !listed.some((m) => m.id === picked)) delete userModels[e]
        const model = userModels[e] || state.models?.[e]?.default || state.health?.engines[e]?.model || undefined
        const prev = lanes[e]
        if (prev.mode === mode && prev.model === model) continue
        const lane: LaneState = { ...prev, mode }
        if (model !== undefined) lane.model = model
        else delete lane.model
        if (state.run === null) lane.info = idleInfo(lane)
        lanes[e] = lane
      }
      return lanes
    }

    const applyLanes = (): void => {
      const state = get()
      const lanes = resolveLanes(state)
      if (!ENGINE_IDS.some((e) => lanes[e] !== state.lanes[e])) return
      // An untouched quick test mirrors the lanes' mode / model.
      const quickIdle = state.quick.status === 'idle' && state.quick.input === null
      set(quickIdle ? { lanes, quick: { ...emptyQuick(lanes), error: state.quick.error } } : { lanes })
    }

    const cancelQuick = (message: string | null): void => {
      if (quickController === null) return
      quickController.abort()
      quickController = null
      quickToken++
      const quick = get().quick
      if (quick.status === 'running') set({ quick: { ...emptyQuick(get().lanes), error: message } })
    }

    const appendRecord = (runId: number, engine: EngineId, record: ClassificationRecord): void => {
      if (!isActive(runId)) return
      set((state) => {
        const lane = state.lanes[engine]
        return { lanes: { ...state.lanes, [engine]: { ...lane, records: [...lane.records, record] } } }
      })
    }

    const finishLane = (runId: number, engine: EngineId, aborted: boolean): void => {
      if (!isActive(runId)) return
      const rerun = current?.rerun === true
      const finishedAt = now()
      set((state) => {
        const lane = state.lanes[engine]
        const info: LaneRunInfo = { ...lane.info, status: aborted ? 'aborted' : 'done' }
        if (!rerun || info.finishedAt === undefined) info.finishedAt = finishedAt
        return { lanes: { ...state.lanes, [engine]: { ...lane, info } } }
      })
      const state = get()
      if (ENGINE_IDS.some((e) => state.lanes[e].info.status === 'running')) return
      const anyAborted = ENGINE_IDS.some((e) => state.lanes[e].info.status === 'aborted')
      current = null
      set({
        status: anyAborted ? 'aborted' : 'done',
        run: state.run && state.run.finishedAt === undefined ? { ...state.run, finishedAt } : state.run,
      })
    }

    /** Starts the given lanes in the same tick. */
    const launch = (
      runId: number,
      signal: AbortSignal,
      run: BenchRun,
      work: ReadonlyArray<{ engine: EngineId; instance: Engine; plan: PlannedItem[] }>,
    ): void => {
      for (const { engine, instance, plan } of work) {
        void runLane({
          engine: instance,
          task: run.task,
          plan,
          concurrency: run.config.concurrency,
          timeoutMs: run.config.timeoutMs,
          model: run.engines[engine].model,
          signal,
          onRecord: (record) => appendRecord(runId, engine, record),
          now,
          perfNow,
        }).then(
          (summary) => finishLane(runId, engine, summary.aborted),
          () => finishLane(runId, engine, signal.aborted),
        )
      }
    }

    const abortCurrent = (): void => {
      if (current === null) return
      current.controller.abort()
      current = null
    }

    return {
      config: { ...DEFAULT_BENCH_CONFIG, datasetId: initialDatasetId },
      datasets: allDatasets(),
      activeDatasetId: initialDatasetId,
      lanes: initialLanes,
      health: null,
      healthLoading: false,
      models: null,
      modelsLoading: false,
      modelsError: null,
      runId: 0,
      status: 'idle',
      run: null,
      error: null,
      storageWarning: null,
      quick: emptyQuick(initialLanes),

      init: () => {
        if (initPromise === null) {
          initPromise = Promise.all([get().refreshHealth(), get().refreshModels(false)]).then(() => undefined)
        }
        return initPromise
      },

      setConfig: (patch) => {
        if (isRunning()) return
        if (patch.datasetId !== undefined && patch.datasetId !== get().activeDatasetId) get().selectDataset(patch.datasetId)
        const { config } = get()
        const next = sanitizeConfig(config, patch)
        next.datasetId = get().activeDatasetId
        set({ config: next })
      },

      selectDataset: (id) => {
        const state = get()
        if (isRunning() || id === state.activeDatasetId) return
        if (!state.datasets.some((d) => d.id === id)) return
        set({ activeDatasetId: id, config: { ...state.config, datasetId: id }, error: null })
      },

      upsertCustomDataset: (dataset) => {
        const validated = validateDataset(dataset)
        if (!validated.ok) return validated
        if (seeds.some((d) => d.id === validated.value.id)) {
          return { ok: false, errors: [`dataset.id: "${validated.value.id}" pertenece a un dataset incluido; usa otro id`] }
        }
        const value: Dataset = { ...validated.value, source: 'custom' }
        const index = customs.findIndex((d) => d.id === value.id)
        customs = index >= 0 ? customs.map((d, i) => (i === index ? value : d)) : [...customs, value]
        set({ datasets: allDatasets(), storageWarning: persist() })
        return { ok: true, value }
      },

      deleteCustomDataset: (id) => {
        if (!customs.some((d) => d.id === id)) return
        customs = customs.filter((d) => d.id !== id)
        const storageWarning = persist()
        const state = get()
        // The run (if any) keeps its own snapshot, so switching the active dataset is safe.
        if (state.activeDatasetId === id) {
          const fallback = defaultDatasetId()
          set({ datasets: allDatasets(), storageWarning, activeDatasetId: fallback, config: { ...state.config, datasetId: fallback } })
        } else {
          set({ datasets: allDatasets(), storageWarning })
        }
      },

      setLaneMode: (engine, mode) => {
        if (isRunning()) return
        if (mode === 'live' && get().health?.engines[engine]?.live !== true) return
        userModes[engine] = mode
        applyLanes()
      },

      setLaneModel: (engine, model) => {
        if (isRunning()) return
        if (model) userModels[engine] = model
        else delete userModels[engine]
        applyLanes()
      },

      refreshHealth: async () => {
        set({ healthLoading: true })
        let health: HealthResponse
        try {
          health = await fetchHealth()
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error)
          health = {
            ok: false,
            engines: {
              gpt: { live: false, model: '', provider: 'OpenAI' },
              jev: { live: false, model: '', provider: 'OpenCode Zen' },
            },
            warnings: [`No se pudo leer /api/health: ${detail}`],
          }
        }
        set({ health, healthLoading: false })
        // Lane mode / model are for the next run: safe to update even mid-run.
        applyLanes()
      },

      refreshModels: async (force = false) => {
        set({ modelsLoading: true })
        let result: ModelsResult
        try {
          result = await fetchModels(force)
        } catch (error) {
          result = { ok: false, error: error instanceof Error ? error.message : String(error) }
        }
        if (result.ok) set({ models: result.models, modelsError: null, modelsLoading: false })
        else set({ modelsError: result.error, modelsLoading: false })
        applyLanes()
      },

      start: () => {
        const state = get()
        const dataset = state.datasets.find((d) => d.id === state.activeDatasetId)
        if (!dataset) {
          set({ error: 'No hay un dataset seleccionado' })
          return
        }
        const config: BenchConfig = { ...state.config, datasetId: dataset.id }
        const plan = buildRunPlan(dataset, config)
        if (plan.length === 0) {
          set({ error: 'Ningún concepto coincide con los filtros (dificultad / límite)' })
          return
        }

        abortCurrent()
        cancelQuick('Cancelada al iniciar la corrida')
        const runId = state.runId + 1
        const controller = new AbortController()
        current = { runId, controller, rerun: false }

        const oracle = oracleFor(plan)
        const startedAt = now()
        const lanes = { ...get().lanes }
        const engines = {} as BenchRun['engines']
        const work: Array<{ engine: EngineId; instance: Engine; plan: PlannedItem[] }> = []
        for (const e of ENGINE_IDS) {
          const lane = lanes[e]
          const instance = createEngine(e, lane.mode, { seed: config.seed, oracle })
          const model = instance.mode === 'live' ? lane.model : undefined
          engines[e] = model !== undefined ? { mode: instance.mode, model } : { mode: instance.mode }
          lanes[e] = {
            ...lane,
            records: [],
            info: {
              engine: e,
              mode: instance.mode,
              model: instance.model ?? displayModel(e, instance.mode, model),
              status: 'running',
              total: plan.length,
              startedAt,
            },
          }
          work.push({ engine: e, instance, plan })
        }
        const run: BenchRun = { datasetId: dataset.id, datasetName: dataset.name, task: dataset.task, plan, config, engines, startedAt }
        set({ runId, status: 'running', error: null, run, lanes })
        launch(runId, controller.signal, run, work)
      },

      stop: () => {
        if (current === null) return
        abortCurrent()
        const finishedAt = now()
        set((state) => {
          const lanes = { ...state.lanes }
          for (const e of ENGINE_IDS) {
            const lane = lanes[e]
            if (lane.info.status !== 'running') continue
            lanes[e] = { ...lane, info: { ...lane.info, status: 'aborted', finishedAt: lane.info.finishedAt ?? finishedAt } }
          }
          const run = state.run && state.run.finishedAt === undefined ? { ...state.run, finishedAt } : state.run
          return { lanes, status: 'aborted', run }
        })
      },

      reset: () => {
        abortCurrent()
        set((state) => {
          const lanes = { ...state.lanes }
          for (const e of ENGINE_IDS) lanes[e] = { ...lanes[e], records: [], info: idleInfo(lanes[e]) }
          return { lanes, status: 'idle', run: null, error: null, runId: state.runId + 1 }
        })
      },

      rerunFailed: () => {
        const state = get()
        const run = state.run
        if (isRunning() || run === null) return
        const failed = {} as Record<EngineId, Set<string>>
        for (const e of ENGINE_IDS) failed[e] = new Set(state.lanes[e].records.filter(isFailedRecord).map((r) => plannedKey(r)))
        if (ENGINE_IDS.every((e) => failed[e].size === 0)) return

        cancelQuick('Cancelada al reintentar los fallidos')
        const runId = state.runId + 1
        const controller = new AbortController()
        current = { runId, controller, rerun: true }
        const oracle = oracleFor(run.plan)
        // A fresh seed: re-running a mock with the same seed would fail the same way.
        const seed = hashSeed(run.config.seed, 'rerun', runId)
        const lanes = { ...state.lanes }
        const work: Array<{ engine: EngineId; instance: Engine; plan: PlannedItem[] }> = []
        for (const e of ENGINE_IDS) {
          if (failed[e].size === 0) continue
          const lane = lanes[e]
          const plan = run.plan.filter((p) => failed[e].has(plannedKey({ itemId: p.item.id, repetition: p.repetition })))
          const instance = createEngine(e, run.engines[e].mode, { seed, oracle })
          lanes[e] = {
            ...lane,
            records: lane.records.filter((r) => !isFailedRecord(r)),
            info: { ...lane.info, status: 'running' },
          }
          work.push({ engine: e, instance, plan })
        }
        set({ runId, status: 'running', error: null, lanes })
        launch(runId, controller.signal, run, work)
      },

      classifyQuick: async (input) => {
        const state = get()
        if (state.status === 'running') {
          set({
            quick: {
              ...state.quick,
              error: 'Espera a que termine la corrida: la prueba rápida usaría conexiones extra y alteraría las latencias.',
            },
          })
          return
        }
        const dataset = state.datasets.find((d) => d.id === state.activeDatasetId)
        if (!dataset) {
          set({ quick: { ...state.quick, error: 'No hay un dataset seleccionado' } })
          return
        }
        const validated = validateConceptInput({ ...input, id: input.id || QUICK_ITEM_ID }, 'concepto')
        if (!validated.ok) {
          set({ quick: { ...state.quick, error: validated.errors.join('; ') } })
          return
        }

        cancelQuick(null)
        const token = ++quickToken
        const controller = new AbortController()
        quickController = controller
        const item = validated.value
        const base = emptyQuick(state.lanes)
        for (const e of ENGINE_IDS) base.lanes[e] = { ...base.lanes[e], status: 'running' }
        set({ quick: { ...base, status: 'running', input: item, datasetId: dataset.id } })

        const noLabel: Oracle = () => undefined
        await Promise.all(
          ENGINE_IDS.map(async (e) => {
            const lane = state.lanes[e]
            const engine = createEngine(e, lane.mode, { seed: state.config.seed, oracle: noLabel })
            const timed = await classifyOnce({
              engine,
              task: dataset.task,
              item,
              timeoutMs: state.config.timeoutMs,
              model: engine.mode === 'live' ? lane.model : undefined,
              signal: controller.signal,
              now,
              perfNow,
            })
            if (token !== quickToken) return
            set((s) => ({
              quick: {
                ...s.quick,
                lanes: {
                  ...s.quick.lanes,
                  [e]: {
                    ...s.quick.lanes[e],
                    model: timed.result.model,
                    status: 'done',
                    result: timed.result,
                    latencyMs: timed.latencyMs,
                  },
                },
              },
            }))
          }),
        )
        if (token !== quickToken) return
        quickController = null
        set((s) => ({ quick: { ...s.quick, status: 'done' } }))
      },

      clearQuick: () => {
        cancelQuick(null)
        set({ quick: emptyQuick(get().lanes) })
      },
    }
  })
}

// ─────────────────────────────── Selectors ────────────────────────────────

export interface RunValidity {
  /** Both lanes live (same mode): the comparison measures the real models. */
  valid: boolean
  /** Some lane is SIMULADO. */
  simulated: boolean
  /** Lanes use different modes. */
  mixedModes: boolean
  modes: Record<EngineId, EngineMode>
  /** Spanish warnings for the UI (empty when valid). */
  warnings: string[]
}

let validityCache: { modes: string; result: RunValidity } | null = null

/**
 * Validity of the current / last run (or of the next one when there is no run). Memoized: returns
 * the same object while the modes do not change, so it is safe as a zustand selector.
 */
export function selectRunValidity(state: Pick<BenchState, 'run' | 'lanes'>): RunValidity {
  const modes = {} as Record<EngineId, EngineMode>
  for (const e of ENGINE_IDS) modes[e] = state.run ? state.run.engines[e].mode : state.lanes[e].mode
  const key = ENGINE_IDS.map((e) => modes[e]).join('|')
  if (validityCache?.modes === key) return validityCache.result

  const mocks = ENGINE_IDS.filter((e) => modes[e] === 'mock')
  const simulated = mocks.length > 0
  const mixedModes = new Set(ENGINE_IDS.map((e) => modes[e])).size > 1
  const warnings: string[] = []
  if (mocks.length === ENGINE_IDS.length) {
    warnings.push('Ambos carriles están en modo SIMULADO: los resultados son ilustrativos y no miden a GPT ni a Jev.')
  } else {
    for (const e of mocks) warnings.push(`${ENGINE_NAMES[e]} está en modo SIMULADO: sus resultados no miden al modelo real.`)
  }
  if (mixedModes) {
    const detail = ENGINE_IDS.map((e) => `${ENGINE_NAMES[e]}: ${MODE_LABELS[modes[e]]}`).join(', ')
    warnings.push(`Los carriles usan modos distintos (${detail}): la comparación no es válida.`)
  }
  const result: RunValidity = { valid: !simulated && !mixedModes, simulated, mixedModes, modes, warnings }
  validityCache = { modes: key, result }
  return result
}

export function selectActiveDataset(state: Pick<BenchState, 'datasets' | 'activeDatasetId'>): Dataset | undefined {
  return state.datasets.find((d) => d.id === state.activeDatasetId)
}

/** The engine can run live (key configured on the server). */
export function selectLiveAvailable(state: Pick<BenchState, 'health'>, engine: EngineId): boolean {
  return state.health?.engines[engine]?.live === true
}

/** Records with status error / timeout / invalid across both lanes (what `rerunFailed` would redo). */
export function selectFailedCount(state: Pick<BenchState, 'lanes'>): number {
  let n = 0
  for (const e of ENGINE_IDS) for (const r of state.lanes[e].records) if (isFailedRecord(r)) n++
  return n
}

/** Lanes are configurable (no run in flight). */
export function selectCanConfigure(state: Pick<BenchState, 'status'>): boolean {
  return state.status !== 'running'
}

