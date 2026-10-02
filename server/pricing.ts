/**
 * Cost estimation from token usage and per-million-token prices.
 *  - GPT: input × price-in + output × price-out (output includes reasoning tokens, which OpenAI bills as output).
 *  - Jev: input × JEV_PRICE_INPUT_PER_MTOK; output tokens are free (OpenCode Zen pricing); `*-free` models cost 0.
 * Per-model price lookup lives in models.ts (`gptPriceFor`, `jevPriceFor`).
 */
import type { TokenUsage } from '../src/shared/contracts.ts'

export interface TokenPrices {
  /** USD per million input tokens. */
  inputPerMTok: number
  /** USD per million output tokens. */
  outputPerMTok: number
}

/** Rounds away float noise (1e-12 USD resolution) so logs stay readable. */
function roundUsd(value: number): number {
  return Math.round(value * 1e12) / 1e12
}

export function costUsd(usage: TokenUsage, prices: TokenPrices): number {
  const input = Math.max(0, usage.inputTokens) * prices.inputPerMTok
  const output = Math.max(0, usage.outputTokens) * prices.outputPerMTok
  return roundUsd((input + output) / 1_000_000)
}
