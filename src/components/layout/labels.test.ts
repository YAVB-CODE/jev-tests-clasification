import { describe, expect, it } from 'vitest'
import { modelOptionLabel } from './labels.ts'

describe('modelOptionLabel', () => {
  it('shows input / output price per MTok for GPT and marks reasoning and the default', () => {
    const label = modelOptionLabel('gpt', { id: 'gpt-5-mini', inputPerMTok: 0.25, outputPerMTok: 2, reasoning: true }, true)
    expect(label).toBe('gpt-5-mini · $0.25 / $2.00 por MTok · razonamiento · por defecto')
  })

  it('shows only the input price for Jev', () => {
    expect(modelOptionLabel('jev', { id: 'jev-1.13', inputPerMTok: 0.042 }, false)).toBe('jev-1.13 · $0.042/MTok')
  })

  it('handles free and unpriced models', () => {
    expect(modelOptionLabel('jev', { id: 'jev-free', priceSource: 'free' }, false)).toBe('jev-free · gratis')
    expect(modelOptionLabel('gpt', { id: 'x' }, false)).toBe('x · precio desconocido')
    expect(modelOptionLabel('gpt', { id: 'y', inputPerMTok: 0, outputPerMTok: 0 }, false)).toBe('y · $0 / $0 por MTok')
  })
})
