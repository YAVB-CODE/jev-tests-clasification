import type { EngineId, EngineMode } from '../shared/contracts.ts'

export const ENGINE_NAMES: Readonly<Record<EngineId, string>> = { gpt: 'GPT', jev: 'Jev' }

export const MODE_LABELS: Readonly<Record<EngineMode, string>> = { live: 'en vivo', mock: 'simulado' }

/** Placeholder shown when a live lane has no known model yet (the server applies its .env default). */
export const SERVER_DEFAULT_MODEL = 'predeterminado del servidor'

/** "GPT · simulado" for mocks, "GPT · gpt-4.1-mini" for live engines. */
export function engineLabel(id: EngineId, mode: EngineMode, model?: string): string {
  const name = ENGINE_NAMES[id]
  return mode === 'mock' ? `${name} · ${MODE_LABELS.mock}` : `${name} · ${model || SERVER_DEFAULT_MODEL}`
}
