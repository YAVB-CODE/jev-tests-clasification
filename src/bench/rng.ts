/**
 * Small seeded randomness helpers (no dependencies). Used by the run plan (shuffle) and by the
 * mock engines, so the same seed gives the same plan and the same simulated answers everywhere.
 */

export type Rng = () => number

/** mulberry32: returns a generator of floats in [0, 1). */
export function createRng(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Stable 32-bit sub-seed from any parts, e.g. hashSeed(seed, 'gpt', itemId, repetition). FNV-1a. */
export function hashSeed(...parts: ReadonlyArray<string | number>): number {
  let h = 0x811c9dc5
  const text = parts.join('|')
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Fisher–Yates shuffle into a NEW array (the input is not touched). */
export function seededShuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    const tmp = out[i]
    out[i] = out[j]
    out[j] = tmp
  }
  return out
}

/** Standard normal (Box–Muller). Always consumes 2 draws. */
export function gaussian(rng: Rng): number {
  const u = Math.max(rng(), 1e-12)
  const v = rng()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** Log-normal sample with the given median and log-space sigma. Always consumes 2 draws. */
export function logNormal(rng: Rng, median: number, sigma: number): number {
  return median * Math.exp(sigma * gaussian(rng))
}
