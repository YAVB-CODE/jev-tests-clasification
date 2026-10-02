/** Shared test fixtures for src/bench and src/engines (not used by the app). */
import type {
  ClassificationTask,
  ClassifyResult,
  ConceptInput,
  Dataset,
  Difficulty,
  EngineId,
  EngineMode,
  LabeledConcept,
} from '../shared/contracts.ts'
import type { ClassifyOptions, Engine } from '../engines/types.ts'

export const TASK: ClassificationTask = {
  instructions: 'Clasifica la línea de factura en una subcuenta del PUC.',
  question: '¿En qué subcuenta se registra?',
  categories: [
    { id: '513525', name: 'Acueducto y alcantarillado', description: 'Agua', group: '5135 Servicios' },
    { id: '513530', name: 'Energía eléctrica', description: 'Luz', group: '5135 Servicios' },
    { id: '513535', name: 'Teléfono', description: 'Telefonía', group: '5135 Servicios' },
    { id: '511025', name: 'Asesoría jurídica', description: 'Abogados', group: '5110 Honorarios' },
    { id: '511030', name: 'Asesoría financiera', description: 'Contadores', group: '5110 Honorarios' },
    { id: 'SIN-GRUPO', name: 'Sin grupo', description: 'Categoría sin grupo' },
  ],
}

const CYCLE: Difficulty[] = ['easy', 'medium', 'hard']

/** `n` labeled items cycling through the categories and difficulties. */
export function makeItems(n: number, task: ClassificationTask = TASK): LabeledConcept[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `item-${i}`,
    concept: `Concepto de prueba ${i}`,
    supplier: `Proveedor ${i % 4}`,
    amount: 1000 * (i + 1),
    currency: 'COP',
    expected: task.categories[i % task.categories.length].id,
    difficulty: CYCLE[i % CYCLE.length],
    rationale: `Porque sí ${i}`,
  }))
}

export function makeDataset(n = 12, id = 'test-ds', overrides: Partial<Dataset> = {}): Dataset {
  return { id, name: `Dataset ${id}`, description: 'Para pruebas', task: TASK, items: makeItems(n), ...overrides }
}

export function okResult(engine: EngineId, categoryId: string, extra: Partial<ClassifyResult> = {}): ClassifyResult {
  return {
    engine,
    mode: 'live',
    model: `${engine}-test`,
    status: 'ok',
    answer: { categoryId, confidence: 0.9 },
    providerLatencyMs: 10,
    ...extra,
  }
}

export interface FakeCall {
  item: ConceptInput
  opts: ClassifyOptions
  resolve: (result: ClassifyResult) => void
}

/** Engine whose calls stay pending until the test resolves them. */
export class DeferredEngine implements Engine {
  readonly id: EngineId
  readonly mode: EngineMode
  readonly model?: string
  readonly calls: FakeCall[] = []

  constructor(id: EngineId, mode: EngineMode = 'live', model?: string) {
    this.id = id
    this.mode = mode
    if (model !== undefined) this.model = model
  }

  classify(_task: ClassificationTask, item: ConceptInput, opts: ClassifyOptions): Promise<ClassifyResult> {
    return new Promise<ClassifyResult>((resolve) => {
      this.calls.push({ item, opts, resolve })
    })
  }
}

/** Engine that answers through `respond` after a microtask (or `delayMs` of timers). */
export class AutoEngine implements Engine {
  readonly id: EngineId
  readonly mode: EngineMode
  readonly calls: Array<{ item: ConceptInput; opts: ClassifyOptions }> = []
  inFlight = 0
  maxInFlight = 0
  private readonly respond: (item: ConceptInput, call: number) => ClassifyResult
  private readonly delayMs: number

  constructor(id: EngineId, respond: (item: ConceptInput, call: number) => ClassifyResult, delayMs = 0, mode: EngineMode = 'live') {
    this.id = id
    this.mode = mode
    this.respond = respond
    this.delayMs = delayMs
  }

  async classify(_task: ClassificationTask, item: ConceptInput, opts: ClassifyOptions): Promise<ClassifyResult> {
    const call = this.calls.length
    this.calls.push({ item, opts })
    this.inFlight++
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs))
      else await Promise.resolve()
      return this.respond(item, call)
    } finally {
      this.inFlight--
    }
  }
}
