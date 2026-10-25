/**
 * Seeded PRNG (mulberry32). The state is a plain number kept in SimState, so a run is fully
 * determined by (scenario, seed, config) and the state can be copied or serialized.
 */
export interface Rng {
  state: number;
}

export function makeRng(seed: number): Rng {
  // Mix the seed so nearby seeds give unrelated sequences.
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return { state: (h ^ (h >>> 16)) >>> 0 };
}

/** Uniform float in [0, 1). */
export function nextFloat(rng: Rng): number {
  rng.state = (rng.state + 0x6d2b79f5) >>> 0;
  let t = rng.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
