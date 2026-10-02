/** Spanish UI copy shared by the app shell. */
import type { Difficulty, EngineId, ModelOption } from '../../shared/contracts.ts'
import type { TabId } from './query.ts'

export const TAB_LABELS: Readonly<Record<TabId, string>> = {
  benchmark: 'Benchmark',
  detalle: 'Detalle',
  dataset: 'Dataset',
  prueba: 'Prueba rápida',
}

export const tabDomId = (id: TabId): string => `app-tab-${id}`
export const panelDomId = (id: TabId): string => `app-panel-${id}`

export const DIFFICULTY_LABELS: Readonly<Record<Difficulty, string>> = {
  easy: 'Fácil',
  medium: 'Media',
  hard: 'Difícil',
}

export const API_KEY_NAME: Readonly<Record<EngineId, string>> = { gpt: 'OPENAI_API_KEY', jev: 'OPENCODE_API_KEY' }

/** The API hot-reloads `.env` (server/index.ts): saving it is enough, no restart (only PORT / HOST need one). */
export const LIVE_UNAVAILABLE_HINT: Readonly<Record<EngineId, string>> = {
  gpt: `Live no disponible: falta ${API_KEY_NAME.gpt} en .env. Agrégala, guarda el archivo y pulsa «Reintentar» en el encabezado (no hace falta reiniciar el backend).`,
  jev: `Live no disponible: falta ${API_KEY_NAME.jev} en .env. Agrégala, guarda el archivo y pulsa «Reintentar» en el encabezado (no hace falta reiniciar el backend).`,
}

function price(perMTok: number): string {
  if (perMTok === 0) return '0'
  return perMTok < 0.1 ? String(Number(perMTok.toFixed(3))) : perMTok.toFixed(2)
}

/**
 * "gpt-4.1-mini · $0.40 in / $1.60 out · por MTok" style label. Jev bills input only.
 * "· razonamiento" marks reasoning models; "· por defecto" the server default.
 */
export function modelOptionLabel(engine: EngineId, option: ModelOption, isDefault: boolean): string {
  const parts = [option.id]
  if (option.priceSource === 'free') parts.push('gratis')
  else if (option.inputPerMTok !== undefined) {
    parts.push(
      engine === 'jev' || option.outputPerMTok === undefined
        ? `$${price(option.inputPerMTok)}/MTok`
        : `$${price(option.inputPerMTok)} / $${price(option.outputPerMTok)} por MTok`,
    )
  } else parts.push('precio desconocido')
  if (option.reasoning) parts.push('razonamiento')
  if (isDefault) parts.push('por defecto')
  return parts.join(' · ')
}
