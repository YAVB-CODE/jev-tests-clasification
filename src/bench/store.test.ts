import { describe, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand/vanilla'
import type { Dataset, EngineId, EngineMode, HealthResponse, ModelsResponse } from '../shared/contracts.ts'
import { SEED_DATASETS } from '../data/datasets.ts'
import { createEngine as realCreateEngine } from '../engines/index.ts'
import type { Engine, Oracle } from '../engines/types.ts'
import type { ModelsResult } from '../engines/api.ts'
import { createBenchStore, selectFailedCount, selectRunValidity, type BenchState, type BenchStoreDeps, type EngineFactoryOptions } from './store.ts'
import { AutoEngine, DeferredEngine, makeDataset, okResult } from './testFixtures.ts'

const DS = makeDataset(9, 'ds-a')
const DS_B = makeDataset(4, 'ds-b')

const HEALTH: HealthResponse = {
  ok: true,
  engines: {
    gpt: { live: true, model: 'gpt-health', provider: 'OpenAI' },
    jev: { live: false, model: 'jev-health', provider: 'OpenCode Zen' },
  },
  warnings: [],
}
const BOTH_LIVE: HealthResponse = { ...HEALTH, engines: { ...HEALTH.engines, jev: { ...HEALTH.engines.jev, live: true } } }

const MODELS: ModelsResponse = {
  gpt: { default: 'gpt-default', models: [{ id: 'gpt-default' }, { id: 'gpt-5-mini' }], source: 'provider' },
  jev: { default: 'jev-default', models: [{ id: 'jev-default' }], source: 'provider' },
}

interface Created {
  id: EngineId
  mode: EngineMode
  opts: EngineFactoryOptions
  engine: Engine
}

type Behavior = (id: EngineId, mode: EngineMode, opts: EngineFactoryOptions) => Engine

/** Answers correctly through the oracle (or the first category without label). */
const correctEngine: Behavior = (id, mode, opts) =>
  new AutoEngine(id, (item) => okResult(id, opts.oracle(item.id)?.expected ?? DS.task.categories[0].id, { mode }), 0, mode)

function harness(behavior: Behavior = correctEngine, extra: Partial<BenchStoreDeps> = {}) {
  const created: Created[] = []
  const saved: Dataset[][] = []
  const fetchHealth = vi.fn(async () => HEALTH)
  const fetchModels = vi.fn(async (): Promise<ModelsResult> => ({ ok: true, models: MODELS }))
  const store = createBenchStore({
    seedDatasets: [DS, DS_B],
    defaultDatasetId: 'ds-a',
    loadCustomDatasets: () => [],
    saveCustomDatasets: (d) => {
      saved.push([...d])
      return true
    },
    createEngine: (id, mode, opts) => {
      const engine = behavior(id, mode, opts)
      created.push({ id, mode, opts, engine })
      return engine
    },
    fetchHealth,
    fetchModels,
    ...extra,
  })
  return { store, s: () => store.getState(), created, saved, fetchHealth, fetchModels }
}

async function settle(store: StoreApi<BenchState>, maxTurns = 200): Promise<void> {
  for (let i = 0; i < maxTurns && store.getState().status === 'running'; i++) await new Promise((r) => setTimeout(r, 0))
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe('initial state and init()', () => {
  it('has defaults, datasets and mock lanes before the health loads', () => {
    const { s } = harness()
    expect(s().config).toMatchObject({ datasetId: 'ds-a', shuffle: true, seed: 42, concurrency: 2, repetitions: 1, timeoutMs: 30_000 })
    expect(s().datasets.map((d) => [d.id, d.source])).toEqual([
      ['ds-a', 'seed'],
      ['ds-b', 'seed'],
    ])
    expect(s().activeDatasetId).toBe('ds-a')
    expect(s().lanes.gpt).toMatchObject({ mode: 'mock', records: [], info: { status: 'idle', mode: 'mock', model: 'mock-gpt', total: 0 } })
    expect(s().status).toBe('idle')
    expect(s().health).toBeNull()
  })

  it('defaults to live when the server has the key, and to the models default; idempotent', async () => {
    const { s, fetchHealth, fetchModels } = harness()
    await Promise.all([s().init(), s().init()])
    await s().init()
    expect(fetchHealth).toHaveBeenCalledTimes(1)
    expect(fetchModels).toHaveBeenCalledTimes(1)
    expect(s().lanes.gpt).toMatchObject({ mode: 'live', model: 'gpt-default', info: { mode: 'live', model: 'gpt-default' } })
    expect(s().lanes.jev).toMatchObject({ mode: 'mock', model: 'jev-default', info: { mode: 'mock', model: 'mock-jev' } })
    expect(s().quick.lanes.gpt).toMatchObject({ mode: 'live', model: 'gpt-default', status: 'idle' })
  })

  it('survives health / models failures', async () => {
    const { s } = harness(correctEngine, {
      fetchHealth: async () => {
        throw new Error('down')
      },
      fetchModels: async () => ({ ok: false, error: 'sin conexión' }),
    })
    await s().init()
    expect(s().health?.ok).toBe(false)
    expect(s().modelsError).toBe('sin conexión')
    expect(s().lanes.gpt.mode).toBe('mock')
  })
})

describe('lane mode / model', () => {
  it('ignores live for an engine without key and keeps explicit choices across refreshes', async () => {
    const { s } = harness()
    await s().init()
    s().setLaneMode('jev', 'live')
    expect(s().lanes.jev.mode).toBe('mock')
    s().setLaneMode('gpt', 'mock')
    await s().refreshHealth()
    expect(s().lanes.gpt.mode).toBe('mock')
    s().setLaneMode('gpt', 'live')
    expect(s().lanes.gpt.mode).toBe('live')
  })

  it('picks a model, returns to the default, and drops picks no longer listed', async () => {
    const h = harness()
    await h.s().init()
    h.s().setLaneModel('gpt', 'gpt-5-mini')
    expect(h.s().lanes.gpt.model).toBe('gpt-5-mini')
    h.s().setLaneModel('gpt', undefined)
    expect(h.s().lanes.gpt.model).toBe('gpt-default')
    h.s().setLaneModel('gpt', 'gpt-5-mini')
    h.fetchModels.mockResolvedValueOnce({ ok: true, models: { ...MODELS, gpt: { ...MODELS.gpt, models: [{ id: 'gpt-default' }] } } })
    await h.s().refreshModels(true)
    expect(h.fetchModels).toHaveBeenLastCalledWith(true)
    expect(h.s().lanes.gpt.model).toBe('gpt-default')
  })
})

describe('setConfig / datasets', () => {
  it('sanitizes the config', () => {
    const { s } = harness()
    s().setConfig({ concurrency: 5 as never, repetitions: 3, timeoutMs: 999_999, seed: -4, limit: 0, difficulties: ['hard', 'easy', 'hard'] })
    expect(s().config).toMatchObject({ concurrency: 2, repetitions: 3, timeoutMs: 180_000, seed: 0, difficulties: ['easy', 'hard'] })
    expect(s().config.limit).toBeUndefined()
    s().setConfig({ limit: 3.7, difficulties: [] })
    expect(s().config.limit).toBe(3)
    expect(s().config.difficulties).toBeUndefined()
    s().setConfig({ datasetId: 'ds-b' })
    expect(s().activeDatasetId).toBe('ds-b')
    expect(s().config.datasetId).toBe('ds-b')
    s().selectDataset('nope')
    expect(s().activeDatasetId).toBe('ds-b')
  })

  it('upserts / deletes custom datasets and persists them', () => {
    const h = harness()
    const custom = makeDataset(3, 'mio')
    const bad = h.s().upsertCustomDataset({ ...custom, items: [] })
    expect(bad.ok).toBe(false)
    const seedClash = h.s().upsertCustomDataset({ ...custom, id: 'ds-a' })
    expect(seedClash.ok).toBe(false)
    const ok = h.s().upsertCustomDataset(custom)
    expect(ok.ok).toBe(true)
    expect(h.s().datasets.map((d) => d.id)).toEqual(['ds-a', 'ds-b', 'mio'])
    expect(h.s().datasets[2].source).toBe('custom')
    h.s().upsertCustomDataset({ ...custom, name: 'Renombrado' })
    expect(h.s().datasets).toHaveLength(3)
    expect(h.s().datasets[2].name).toBe('Renombrado')
    expect(h.saved).toHaveLength(2)
    h.s().selectDataset('mio')
    h.s().deleteCustomDataset('mio')
    expect(h.s().datasets).toHaveLength(2)
    expect(h.s().activeDatasetId).toBe('ds-a')
    expect(h.saved.at(-1)).toEqual([])
    h.s().deleteCustomDataset('ds-a') // seeds cannot be deleted
    expect(h.s().datasets).toHaveLength(2)
  })

  it('loads persisted custom datasets and warns when saving fails', () => {
    const h = harness(correctEngine, { loadCustomDatasets: () => [makeDataset(2, 'guardado')], saveCustomDatasets: () => false })
    expect(h.s().datasets.map((d) => d.id)).toEqual(['ds-a', 'ds-b', 'guardado'])
    h.s().upsertCustomDataset(makeDataset(2, 'otro'))
    expect(h.s().storageWarning).toContain('No se pudieron guardar')
  })
})

describe('start()', () => {
  it('builds the plan once and launches both lanes in the same tick', async () => {
    const h = harness()
    await h.s().init()
    h.s().start()
    // both engines exist and have their first calls in flight synchronously
    expect(h.created.map((c) => [c.id, c.mode])).toEqual([
      ['gpt', 'live'],
      ['jev', 'mock'],
    ])
    expect(h.created[0].opts.oracle).toBe(h.created[1].opts.oracle)
    expect(h.created.map((c) => (c.engine as AutoEngine).calls.length)).toEqual([2, 2])
    expect((h.created[0].engine as AutoEngine).calls[0].opts.model).toBe('gpt-default')
    expect(h.s().status).toBe('running')
    expect(h.s().runId).toBe(1)
    expect(h.s().lanes.gpt.info).toMatchObject({ status: 'running', total: 9, mode: 'live', model: 'gpt-default' })
    expect(h.s().run?.engines).toEqual({ gpt: { mode: 'live', model: 'gpt-default' }, jev: { mode: 'mock' } })

    const seen = new Set<unknown>()
    const unsub = h.store.subscribe((state) => seen.add(state.lanes.gpt.records))
    await settle(h.store)
    unsub()
    expect(seen.size).toBeGreaterThan(5) // a new array per record
    expect(h.s().status).toBe('done')
    for (const e of ['gpt', 'jev'] as const) {
      expect(h.s().lanes[e].records).toHaveLength(9)
      expect(h.s().lanes[e].info.status).toBe('done')
      expect(h.s().lanes[e].info.finishedAt).toBeDefined()
    }
    const order = (e: EngineId) => [...h.s().lanes[e].records].sort((a, b) => a.index - b.index).map((r) => r.itemId)
    expect(order('gpt')).toEqual(order('jev'))
    expect(order('gpt')).toEqual(h.s().run!.plan.map((p) => p.item.id))
    expect(h.s().lanes.gpt.records.every((r) => r.correct)).toBe(true)
    expect(h.s().run?.finishedAt).toBeDefined()
  })

  it('reports an empty plan instead of starting', () => {
    const { s } = harness()
    const noHard: Dataset = { ...makeDataset(3, 'x') }
    noHard.items = noHard.items.map((i) => ({ ...i, difficulty: 'easy' as const }))
    s().upsertCustomDataset(noHard)
    s().selectDataset('x')
    s().setConfig({ difficulties: ['hard'] })
    s().start()
    expect(s().status).toBe('idle')
    expect(s().error).toContain('Ningún concepto')
  })

  it('aborts the previous run and drops its late events', async () => {
    const h = harness((id, mode) => new DeferredEngine(id, mode))
    h.s().start()
    const first = h.created.slice(0, 2).map((c) => c.engine as DeferredEngine)
    h.s().start()
    expect(h.s().runId).toBe(2)
    expect(first.every((e) => e.calls.every((c) => c.opts.signal.aborted))).toBe(true)
    first[0].calls[0].resolve(okResult('gpt', '513525'))
    await flush()
    expect(h.s().lanes.gpt.records).toHaveLength(0)
    expect(h.s().status).toBe('running')
    const second = h.created.slice(2).map((c) => c.engine as DeferredEngine)
    second[0].calls[0].resolve(okResult('gpt', '513525'))
    await flush()
    expect(h.s().lanes.gpt.records).toHaveLength(1)
  })
})

describe('stop() / reset()', () => {
  it('stop aborts both lanes, keeps partial records and ignores late answers', async () => {
    const h = harness((id, mode) => new DeferredEngine(id, mode))
    h.s().start()
    const [gpt, jev] = h.created.map((c) => c.engine as DeferredEngine)
    gpt.calls[0].resolve(okResult('gpt', '513525'))
    await flush()
    expect(h.s().lanes.gpt.records).toHaveLength(1)
    h.s().stop()
    expect(h.s().status).toBe('aborted')
    expect(h.s().lanes.gpt.info.status).toBe('aborted')
    expect(h.s().lanes.jev.info.status).toBe('aborted')
    expect(h.s().run?.finishedAt).toBeDefined()
    jev.calls[0].resolve(okResult('jev', '513525'))
    gpt.calls[1].resolve(okResult('gpt', '513525'))
    await flush()
    expect(h.s().lanes.gpt.records).toHaveLength(1)
    expect(h.s().lanes.jev.records).toHaveLength(0)
    expect(h.s().status).toBe('aborted')
  })

  it('reset clears the run and its records', async () => {
    const h = harness((id, mode) => new DeferredEngine(id, mode))
    h.s().start()
    const [gpt] = h.created.map((c) => c.engine as DeferredEngine)
    h.s().reset()
    expect(h.s()).toMatchObject({ status: 'idle', run: null, runId: 2 })
    expect(h.s().lanes.gpt.info).toMatchObject({ status: 'idle', total: 0 })
    gpt.calls[0].resolve(okResult('gpt', '513525'))
    await flush()
    expect(h.s().lanes.gpt.records).toHaveLength(0)
  })
})

describe('rerunFailed()', () => {
  it('re-runs only the failed records of each lane and replaces them', async () => {
    // first engine pair fails some items; engines created later always succeed
    let pair = 0
    const failing = new Set(['item-1', 'item-4'])
    const h = harness((id, mode, opts) => {
      const round = pair++ < 2 ? 0 : 1
      return new AutoEngine(
        id,
        (item) => {
          const expected = opts.oracle(item.id)!.expected
          if (round === 0 && id === 'gpt' && failing.has(item.id)) {
            return { engine: id, mode, model: 'm', status: item.id === 'item-1' ? 'timeout' : 'invalid', answer: { categoryId: null } }
          }
          if (round === 0 && id === 'jev' && item.id === 'item-2') {
            return { engine: id, mode, model: 'm', status: 'error', answer: { categoryId: null }, errorMessage: 'HTTP 500' }
          }
          return okResult(id, expected, { mode })
        },
        0,
        mode,
      )
    })
    h.s().start()
    await settle(h.store)
    expect(h.s().lanes.gpt.records.filter((r) => r.status !== 'ok')).toHaveLength(2)
    expect(h.s().lanes.jev.records.filter((r) => r.status !== 'ok')).toHaveLength(1)
    const plan = h.s().run!.plan
    expect(selectFailedCount(h.s())).toBe(3)

    h.s().rerunFailed()
    expect(h.s().status).toBe('running')
    expect(h.s().runId).toBe(2)
    const rerun = h.created.slice(2)
    expect(rerun.map((c) => c.id)).toEqual(['gpt', 'jev'])
    expect(rerun[0].opts.seed).not.toBe(42)
    await settle(h.store)
    expect((rerun[0].engine as AutoEngine).calls.map((c) => c.item.id).sort()).toEqual(['item-1', 'item-4'])
    expect((rerun[1].engine as AutoEngine).calls.map((c) => c.item.id)).toEqual(['item-2'])
    expect(h.s().status).toBe('done')
    for (const e of ['gpt', 'jev'] as const) {
      const records = h.s().lanes[e].records
      expect(records).toHaveLength(9)
      expect(records.every((r) => r.status === 'ok')).toBe(true)
      expect(new Set(records.map((r) => r.index))).toEqual(new Set(plan.map((p) => p.index)))
    }
    expect(selectFailedCount(h.s())).toBe(0)
    // nothing left to re-run
    h.s().rerunFailed()
    expect(h.s().status).toBe('done')
  })
})

describe('classifyQuick()', () => {
  it('classifies one unlabeled concept with both engines in parallel', async () => {
    const h = harness()
    await h.s().init()
    const pending = h.s().classifyQuick({ concept: '  Energía eléctrica marzo  ', supplier: 'Enel' })
    expect(h.s().quick.status).toBe('running')
    expect(h.created).toHaveLength(2)
    expect(h.created[0].opts.oracle('prueba-rapida')).toBeUndefined()
    await pending
    const quick = h.s().quick
    expect(quick.status).toBe('done')
    expect(quick.input).toEqual({ id: 'prueba-rapida', concept: 'Energía eléctrica marzo', supplier: 'Enel' })
    expect(quick.datasetId).toBe('ds-a')
    for (const e of ['gpt', 'jev'] as const) {
      expect(quick.lanes[e].status).toBe('done')
      expect(quick.lanes[e].result?.status).toBe('ok')
      expect(quick.lanes[e].latencyMs).toBeGreaterThanOrEqual(0)
    }
    expect((h.created[0].engine as AutoEngine).calls[0].opts.model).toBe('gpt-default')
  })

  it('validates the input and refuses while a run is in progress', async () => {
    const h = harness((id, mode) => new DeferredEngine(id, mode))
    await h.s().classifyQuick({ concept: '   ' })
    expect(h.s().quick.error).toContain('concepto.concept')
    expect(h.s().quick.status).toBe('idle')
    h.s().start()
    await h.s().classifyQuick({ concept: 'Algo' })
    expect(h.s().quick.error).toContain('Espera a que termine')
  })

  it('a newer quick test supersedes the previous one', async () => {
    const h = harness((id, mode) => new DeferredEngine(id, mode))
    const first = h.s().classifyQuick({ concept: 'Uno' })
    const firstEngines = h.created.map((c) => c.engine as DeferredEngine)
    const second = h.s().classifyQuick({ concept: 'Dos' })
    expect(firstEngines[0].calls[0].opts.signal.aborted).toBe(true)
    firstEngines[0].calls[0].resolve(okResult('gpt', '513525'))
    await first
    expect(h.s().quick.lanes.gpt.status).toBe('running')
    for (const c of h.created.slice(2)) (c.engine as DeferredEngine).calls[0].resolve(okResult(c.id, '513530'))
    await second
    expect(h.s().quick.input?.concept).toBe('Dos')
    expect(h.s().quick.lanes.gpt.result?.answer.categoryId).toBe('513530')
  })
})

describe('selectRunValidity', () => {
  it('flags simulated and mixed-mode runs, and is memoized', async () => {
    const h = harness(correctEngine, { fetchHealth: async () => BOTH_LIVE })
    const v0 = selectRunValidity(h.s())
    expect(v0).toMatchObject({ valid: false, simulated: true, mixedModes: false })
    expect(v0.warnings[0]).toContain('SIMULADO')
    expect(selectRunValidity(h.s())).toBe(v0)

    await h.s().init()
    const live = selectRunValidity(h.s())
    expect(live).toMatchObject({ valid: true, simulated: false, warnings: [] })

    h.s().setLaneMode('jev', 'mock')
    const mixed = selectRunValidity(h.s())
    expect(mixed).toMatchObject({ valid: false, simulated: true, mixedModes: true })
    expect(mixed.warnings.join(' ')).toContain('modos distintos')
  })

  it('uses the modes of the run once one exists', async () => {
    const h = harness(correctEngine, { fetchHealth: async () => BOTH_LIVE })
    await h.s().init()
    h.s().start()
    await settle(h.store)
    h.s().setLaneMode('gpt', 'mock') // next run only
    expect(selectRunValidity(h.s()).valid).toBe(true)
  })
})

describe('integration with the real MockEngine and seed dataset', () => {
  it('runs a full simulated benchmark with plausible results', async () => {
    const noSleep = async (): Promise<void> => undefined
    const store = createBenchStore({
      seedDatasets: SEED_DATASETS,
      createEngine: (id, mode, opts: { seed: number; oracle: Oracle }) => realCreateEngine(id, mode, { ...opts, sleep: noSleep }),
      fetchHealth: async () => ({ ...HEALTH, engines: { gpt: { ...HEALTH.engines.gpt, live: false }, jev: HEALTH.engines.jev } }),
      fetchModels: async () => ({ ok: true, models: MODELS }),
    })
    await store.getState().init()
    store.getState().setConfig({ concurrency: 3, repetitions: 2 })
    store.getState().start()
    await settle(store, 2000)
    const state = store.getState()
    expect(state.status).toBe('done')
    const total = SEED_DATASETS[0].items.length * 2
    for (const e of ['gpt', 'jev'] as const) {
      const records = state.lanes[e].records
      expect(records).toHaveLength(total)
      expect(records.every((r) => r.mode === 'mock' && r.estimated === true && r.model === `mock-${e}`)).toBe(true)
      const accuracy = records.filter((r) => r.correct).length / records.length
      expect(accuracy).toBeGreaterThan(0.6)
      expect(accuracy).toBeLessThan(0.98)
    }
    // the mock is deterministic: a second identical run reproduces the predictions
    const before = (e: EngineId) => [...state.lanes[e].records].sort((a, b) => a.index - b.index).map((r) => r.predicted)
    const snapshot = { gpt: before('gpt'), jev: before('jev') }
    store.getState().start()
    await settle(store, 2000)
    const after = (e: EngineId) => [...store.getState().lanes[e].records].sort((a, b) => a.index - b.index).map((r) => r.predicted)
    expect(after('gpt')).toEqual(snapshot.gpt)
    expect(after('jev')).toEqual(snapshot.jev)
  })
})
