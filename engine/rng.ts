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

export function makeRng(seed: number): Rng {
  return xoroshiro128plus(seed);
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
