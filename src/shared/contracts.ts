/**
 * Jev Classify Lab — contrato compartido entre cliente (src/) y servidor (server/).
 *
 * INTERFAZ CONGELADA. Todos los módulos (datos, métricas, motores, runner, servidor, UI) se
 * hablan solo a través de estos tipos. No los cambies sin coordinarlo con el líder del proyecto:
 * si necesitas algo distinto, impleméntalo alrededor y repórtalo.
 *
 * Solo tipos y constantes pequeñas, sin dependencias: lo importan tanto el navegador como Node.
 * El texto que se envía a los modelos y la validación de entradas viven en `./task.ts`.
 *
 * Reglas de equidad (ver PLAN.md): ambos motores reciben el mismo texto y el mismo concepto,
 * el servidor nunca recibe la etiqueta esperada y la calificación ocurre en el cliente.
 */

// ─────────────────────────────── Motores ────────────────────────────────

/** `gpt` = OpenAI (carril izquierdo); `jev` = Jev «System One» vía OpenCode Zen (carril derecho). */
export type EngineId = 'gpt' | 'jev'
/** Orden canónico de los carriles: izquierda → derecha. */
export const ENGINE_IDS: readonly EngineId[] = ['gpt', 'jev']

/** `live` = llamada real a través del servidor; `mock` = simulado en el cliente (sin red ni keys). */
export type EngineMode = 'live' | 'mock'
export const ENGINE_MODES: readonly EngineMode[] = ['live', 'mock']

export function isEngineId(value: unknown): value is EngineId {
  return typeof value === 'string' && (ENGINE_IDS as readonly string[]).includes(value)
}

// ─────────────────────────────── Dominio ────────────────────────────────

/** Una categoría destino (en el dataset semilla, una subcuenta del PUC colombiano). */
export interface Category {
  /**
   * Clave estable que ven ambos modelos como opción de respuesta (p. ej. el código PUC "513530").
   * Formato: `CATEGORY_ID_PATTERN` (task.ts). Única dentro de la tarea (sin distinguir mayúsculas).
   */
  id: string
  /** Nombre corto, p. ej. "Energía eléctrica". */
  name: string
  /** Criterio: cuándo un concepto va en esta categoría. Se envía verbatim a ambos motores (puede ser ""). */
  description: string
  /** Agrupación superior, p. ej. "5135 Servicios": acierto por grupo y agrupación en la UI. */
  group?: string
}

export type Difficulty = 'easy' | 'medium' | 'hard'
export const DIFFICULTIES: readonly Difficulty[] = ['easy', 'medium', 'hard']

export function isDifficulty(value: unknown): value is Difficulty {
  return typeof value === 'string' && (DIFFICULTIES as readonly string[]).includes(value)
}

/**
 * Un concepto (línea de factura) tal como entra a un motor. Es lo único que los modelos ven del
 * item, y lo ven ya serializado con `serializeConcept` (task.ts), que quita el `id`.
 */
export interface ConceptInput {
  /** Identificador del item dentro del dataset. Nunca se envía a los modelos. */
  id: string
  /** Texto de la línea de factura, p. ej. "Servicio de energía periodo marzo". */
  concept: string
  /** Nombre del proveedor, si se conoce. */
  supplier?: string
  /** Valor de la línea (número, sin formato). */
  amount?: number
  /** Código de moneda, p. ej. "COP". */
  currency?: string
  /** Contexto adicional de la factura. */
  notes?: string
}

/** Concepto con su respuesta correcta. La etiqueta solo vive en el cliente. */
export interface LabeledConcept extends ConceptInput {
  /** `Category.id` correcto. Jamás sale del navegador. */
  expected: string
  difficulty?: Difficulty
  /** Por qué es esa la categoría correcta. Solo para la UI; nunca se envía a los modelos. */
  rationale?: string
}

/** La tarea de clasificación: idéntica para ambos motores (ver task.ts → buildCanonicalPrompt). */
export interface ClassificationTask {
  /** Brief de la tarea (contexto contable, cómo decidir). */
  instructions: string
  /** Pregunta que se responde para cada concepto. */
  question: string
  /** Opciones de respuesta, en orden canónico (mínimo 2). */
  categories: Category[]
}

export type DatasetSource = 'seed' | 'custom'

export interface Dataset {
  id: string
  name: string
  description: string
  /** BCP 47, p. ej. "es-CO". */
  locale?: string
  /** `seed` = incluido en la app (no editable); `custom` = importado/editado por el usuario. */
  source?: DatasetSource
  task: ClassificationTask
  items: LabeledConcept[]
}

/** Id del dataset semilla (src/data/puc-colombia.ts). */
export const SEED_DATASET_ID = 'puc-colombia'

// ───────────────────────────────── API ──────────────────────────────────
// POST /api/classify  body ClassifyRequest → 200 ClassifyResult (nunca lanza: los fallos del
//                     modelo van dentro con status 'invalid' | 'error' | 'timeout');
//                     400 ApiErrorBody solo si la request es inválida.
// GET  /api/health    → HealthResponse
// GET  /api/models    → ModelsResponse (?refresh=1 ignora la caché del servidor)

export const API_ROUTES = {
  classify: '/api/classify',
  health: '/api/health',
  models: '/api/models',
} as const

/**
 * Body de POST /api/classify. NUNCA lleva la etiqueta esperada: el servidor valida con
 * `validateTask` / `validateConceptInput` (task.ts), que descartan cualquier campo desconocido.
 */
export interface ClassifyRequest {
  engine: EngineId
  /** Modelo elegido en la UI (ver GET /api/models). Omitido → el default del servidor (.env). */
  model?: string
  task: ClassificationTask
  item: ConceptInput
}

/**
 * - `ok`: respuesta válida dentro del conjunto de categorías.
 * - `invalid`: el modelo respondió, pero fuera del conjunto / JSON malformado / sin respuesta.
 * - `error`: fallo HTTP, de red, de configuración (sin key) o del proveedor.
 * - `timeout`: se agotó el tiempo (del servidor o del runner en el cliente).
 */
export type ClassifyStatus = 'ok' | 'invalid' | 'error' | 'timeout'
export const CLASSIFY_STATUSES: readonly ClassifyStatus[] = ['ok', 'invalid', 'error', 'timeout']

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

/** Un intento HTTP al proveedor (los reintentos nunca son silenciosos). */
export interface AttemptLog {
  /** 1 = primer intento, 2 = primer reintento, ... */
  attempt: number
  /** Código HTTP, o null si falló antes de recibir respuesta (red / abort / timeout). */
  status: number | null
  /** Tiempo hasta los headers de la respuesta en este intento, en ms. */
  ms: number
  error?: string
}

/** Origen de `ClassifyAnswer.nativeConfidence`. */
export type NativeConfidenceKind = 'logprob' | 'jev_confidence'
export const NATIVE_CONFIDENCE_KINDS: readonly NativeConfidenceKind[] = ['logprob', 'jev_confidence']

export interface ClassifyAnswer {
  /** `Category.id` elegido; null si la respuesta fue inválida o hubo error/timeout. */
  categoryId: string | null
  /**
   * 0..1: probabilidad que el motor asigna a que `categoryId` sea correcta. Es LA señal comparable
   * entre motores (calibración: Brier, ECE, AUROC). GPT = autodeclarada en su JSON;
   * Jev = `probabilities[choice]`.
   */
  confidence?: number
  /** Distribución sobre ids de categoría, si el motor la da (Jev nativo). Claves ⊆ categoryIds. */
  probabilities?: Record<string, number>
  /**
   * Señal secundaria, solo informativa (no se compara entre motores):
   * GPT = probabilidad derivada de los logprobs de los tokens del id elegido (`logprob`);
   * Jev = estadístico nativo `confidence` de la respuesta Choice (`jev_confidence`, no es una probabilidad).
   */
  nativeConfidence?: number
  nativeConfidenceKind?: NativeConfidenceKind
}

export interface ClassifyResult {
  engine: EngineId
  mode: EngineMode
  /** Modelo que respondió, p. ej. "gpt-4.1-mini", "jev-1.13", "mock-gpt". */
  model: string
  status: ClassifyStatus
  answer: ClassifyAnswer
  /** Latencia de la llamada al proveedor medida en el servidor (incluye reintentos), o simulada (mock), en ms. */
  providerLatencyMs?: number
  usage?: TokenUsage
  costUsd?: number
  /** true cuando usage / costo son estimados (motores mock). */
  estimated?: boolean
  /** Mensaje listo para la UI cuando status ≠ 'ok' (nunca contiene API keys). */
  errorMessage?: string
  attempts?: AttemptLog[]
  /** Payloads crudos para el detalle (request enviada al proveedor, respuesta recibida), sin secretos. */
  raw?: { request?: unknown; response?: unknown }
}

/** Respuesta 200 de POST /api/classify. */
export type ClassifyResponse = ClassifyResult

// ─────────────────────────── Modelos y salud ────────────────────────────

export interface ModelOption {
  id: string
  /** USD por millón de tokens, cuando se conoce. Jev cobra solo input. */
  inputPerMTok?: number
  outputPerMTok?: number
  /** De dónde sale el precio: .env, la tabla interna (puede estar desactualizada) o modelo gratis. */
  priceSource?: 'env' | 'table' | 'free'
  /** Modelo de razonamiento de GPT (gpt-5*, serie o): más lento, gasta tokens de razonamiento ocultos. */
  reasoning?: boolean
}

export interface EngineModels {
  /** Default del servidor (OPENAI_MODEL / JEV_MODEL). */
  default: string
  provider?: string
  models: ModelOption[]
  /** 'provider' = listado por el /v1/models del proveedor; 'fallback' = lista interna (sin key o falló el listado). */
  source: 'provider' | 'fallback'
  error?: string
}

/** GET /api/models */
export type ModelsResponse = Record<EngineId, EngineModels>

export interface EngineHealth {
  /** Hay API key configurada: el motor puede correr en modo `live`. */
  live: boolean
  /** Modelo por defecto del servidor. */
  model: string
  /** Gateway que sirve el modelo, para mostrar (p. ej. "OpenAI", "OpenCode Zen"). */
  provider: string
}

/** GET /api/health */
export interface HealthResponse {
  /** El servidor responde. Que un motor no tenga key no lo pone en false: va en `warnings`. */
  ok: boolean
  engines: Record<EngineId, EngineHealth>
  /** Avisos legibles para la UI (en español), p. ej. "Falta OPENAI_API_KEY: GPT solo en modo simulado". */
  warnings: string[]
}

/** Cuerpo de cualquier respuesta no-200 de la API. */
export interface ApiErrorBody {
  error: string
  /** Errores de validación con ruta del campo, p. ej. "task.categories[3].id: duplicado". */
  details?: string[]
}

// ───────────────────────────── Benchmark ────────────────────────────────

/** Opciones válidas de concurrencia por carril (total ≤ 6 por el límite HTTP/1.1 del navegador). */
export const CONCURRENCY_OPTIONS = [1, 2, 3] as const
export type BenchConcurrency = (typeof CONCURRENCY_OPTIONS)[number]

/** Opciones válidas de repeticiones por concepto (>1 para medir consistencia). */
export const REPETITION_OPTIONS = [1, 2, 3] as const
export type BenchRepetitions = (typeof REPETITION_OPTIONS)[number]

export const BENCH_LIMITS = {
  minTimeoutMs: 1_000,
  maxTimeoutMs: 180_000,
} as const

export interface BenchConfig {
  datasetId: string
  /** Filtra items por dificultad. undefined o [] = todas. */
  difficulties?: Difficulty[]
  /** Máximo de items (después de filtrar y barajar). undefined = todos. */
  limit?: number
  /** Barajar con `seed` (mismo orden para ambos carriles). */
  shuffle: boolean
  seed: number
  /** Requests simultáneas POR CARRIL; ambos carriles usan la misma. */
  concurrency: BenchConcurrency
  /** Veces que se clasifica cada item (consistencia). */
  repetitions: BenchRepetitions
  /** Timeout extremo a extremo por clasificación (mismo para ambos carriles), en ms. */
  timeoutMs: number
}

export const DEFAULT_BENCH_CONFIG: Readonly<BenchConfig> = Object.freeze({
  datasetId: SEED_DATASET_ID,
  shuffle: true,
  seed: 42,
  concurrency: 2,
  repetitions: 1,
  timeoutMs: 30_000,
})

/** Una clasificación calificada. La produce el runner (cliente); la consumen métricas y UI. */
export interface ClassificationRecord {
  engine: EngineId
  mode: EngineMode
  model: string
  itemId: string
  /** Posición 0-based en la cola de ejecución del carril (mismo orden en ambos carriles). */
  index: number
  /** 0-based: 0 = primera pasada. */
  repetition: number
  /** `Category.id` esperado. */
  expected: string
  /** `Category.id` predicho; null si inválido / error / timeout. */
  predicted: string | null
  /** predicted === expected. Inválido / error / timeout = false. */
  correct: boolean
  /** Predicho y esperado comparten `Category.group`. undefined si alguna de las dos no tiene grupo o no hubo predicción. */
  groupCorrect?: boolean
  status: ClassifyStatus
  confidence?: number
  probabilities?: Record<string, number>
  nativeConfidence?: number
  nativeConfidenceKind?: NativeConfidenceKind
  /** Extremo a extremo, medido en el navegador alrededor de la llamada al motor, en ms. */
  latencyMs: number
  providerLatencyMs?: number
  usage?: TokenUsage
  costUsd?: number
  /** true cuando usage / costo son estimados (mock). */
  estimated?: boolean
  errorMessage?: string
  difficulty?: Difficulty
  /** Intentos HTTP al proveedor (detalle). */
  attempts?: AttemptLog[]
  /** Payloads crudos (detalle). Puede omitirse para ahorrar memoria / tamaño de exportación. */
  raw?: ClassifyResult['raw']
  /** epoch ms */
  startedAt: number
  /** epoch ms */
  finishedAt: number
}

/** Clave única de un registro dentro de una corrida: `${engine}:${itemId}:${repetition}`. */
export function recordKey(record: Pick<ClassificationRecord, 'engine' | 'itemId' | 'repetition'>): string {
  return `${record.engine}:${record.itemId}:${record.repetition}`
}

export type LaneStatus = 'idle' | 'running' | 'done' | 'aborted'
export const LANE_STATUSES: readonly LaneStatus[] = ['idle', 'running', 'done', 'aborted']

/** Estado de un carril durante / después de una corrida. */
export interface LaneRunInfo {
  engine: EngineId
  mode: EngineMode
  model: string
  status: LaneStatus
  /** Clasificaciones programadas: items × repeticiones. */
  total: number
  /** epoch ms */
  startedAt?: number
  /** epoch ms */
  finishedAt?: number
}
