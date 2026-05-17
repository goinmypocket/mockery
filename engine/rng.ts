// =============================================================================
// Seeded RNG. Same convention as coke-and-iron: pure-rand's xoroshiro128+.
// Replay-deterministic; the generator state travels on GameState and
// round-trips through serialize/load.
// =============================================================================

import {
  xoroshiro128plus,
  unsafeUniformIntDistribution,
  type RandomGenerator,
} from "pure-rand";

export type Rng = RandomGenerator;
/** Snapshot of the generator's internal state — round-trips via JSON. */
export type RngState = number[];

export function makeRng(seed: number): Rng {
  return xoroshiro128plus(seed);
}

/** Capture the generator's current state so it can be JSON-serialised. */
export function getRngState(rng: Rng): RngState {
  // pure-rand's RandomGenerator interface includes getState() at runtime;
  // it isn't on the public TS surface, so we cast.
  const state = (rng as unknown as { getState?: () => number[] }).getState?.();
  if (!state) throw new Error("rng does not expose getState");
  return state.slice();
}

/** Reconstitute a generator from a state captured by `getRngState`. */
export function rngFromState(state: RngState): Rng {
  return xoroshiro128plus.fromState(state);
}

export function shuffle<T>(arr: readonly T[], rng: Rng): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = unsafeUniformIntDistribution(0, i, rng);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/** Inclusive on both ends. Mutates rng in place. */
export function randomInt(min: number, max: number, rng: Rng): number {
  return unsafeUniformIntDistribution(min, max, rng);
}

/** Deterministic seed derived from a base seed and a string key
 *  (FNV-1a hash XOR base). Used wherever a sub-system needs its own
 *  replay-stable RNG keyed off the engine's master seed plus a
 *  stable identifier (entityId, groupId, etc.). */
export function deriveSeed(base: number, key: string): number {
  let h = base >>> 0;
  for (let i = 0; i < key.length; i++) {
    h = ((h ^ key.charCodeAt(i)) * 16777619) >>> 0;
  }
  return h;
}
