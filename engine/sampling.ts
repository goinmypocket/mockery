// =============================================================================
// Parameter distribution sampler. See docs/bot-spawning-model.md §4.
//
// All draws use the engine's seeded Rng so they're replay-stable.
// Integer variants round after clamping; clamps for unbounded
// distributions are honoured when min/max are provided.
// =============================================================================

import { unsafeUniformIntDistribution } from "pure-rand";
import type { Rng } from "./rng";

export type Distribution =
  | { kind: "constant"; value: number }
  | { kind: "uniform"; min: number; max: number }
  | { kind: "uniform-int"; min: number; max: number }
  | { kind: "gaussian"; mean: number; std: number; min?: number; max?: number }
  | { kind: "gaussian-int"; mean: number; std: number; min?: number; max?: number }
  | { kind: "exponential"; rate: number; min?: number; max?: number }
  | { kind: "exponential-int"; rate: number; min?: number; max?: number }
  | { kind: "categorical"; choices: readonly { value: number; weight: number }[] };

export function sample(dist: Distribution, rng: Rng): number {
  switch (dist.kind) {
    case "constant":
      return dist.value;
    case "uniform":
      return dist.min + (dist.max - dist.min) * randomFloat(rng);
    case "uniform-int":
      return unsafeUniformIntDistribution(dist.min, dist.max, rng);
    case "gaussian":
      return clamp(gaussian(dist.mean, dist.std, rng), dist.min, dist.max);
    case "gaussian-int":
      return Math.round(clamp(gaussian(dist.mean, dist.std, rng), dist.min, dist.max));
    case "exponential":
      return clamp(exponential(dist.rate, rng), dist.min, dist.max);
    case "exponential-int":
      return Math.round(clamp(exponential(dist.rate, rng), dist.min, dist.max));
    case "categorical":
      return categorical(dist.choices, rng);
  }
}

/** Bulk draw: maps a record of distributions to a record of samples. */
export function sampleAll<K extends string>(
  schema: Readonly<Record<K, Distribution>>,
  rng: Rng,
): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const k of Object.keys(schema) as K[]) out[k] = sample(schema[k], rng);
  return out;
}

// ---------------------------------------------------------------------------

const UNIT_DENOM = 2 ** 32;

function randomFloat(rng: Rng): number {
  // Uniform [0, 1). Pure-rand exposes a 32-bit unsigned int via the same
  // unsafeUniformIntDistribution we use elsewhere; divide by 2^32.
  return unsafeUniformIntDistribution(0, UNIT_DENOM - 1, rng) / UNIT_DENOM;
}

function gaussian(mean: number, std: number, rng: Rng): number {
  // Box-Muller, single draw of the pair.
  const u1 = Math.max(randomFloat(rng), Number.MIN_VALUE);
  const u2 = randomFloat(rng);
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + std * z;
}

function exponential(rate: number, rng: Rng): number {
  // -ln(1 - u) / λ. Guard against rate ≤ 0 (would produce Infinity / NaN).
  const r = Math.max(rate, 1e-12);
  return -Math.log(1 - randomFloat(rng)) / r;
}

function clamp(x: number, min: number | undefined, max: number | undefined): number {
  if (min !== undefined && x < min) return min;
  if (max !== undefined && x > max) return max;
  return x;
}

function categorical(
  choices: readonly { value: number; weight: number }[],
  rng: Rng,
): number {
  if (choices.length === 0) throw new Error("categorical: empty choices");
  let total = 0;
  for (const c of choices) total += Math.max(c.weight, 0);
  if (total <= 0) throw new Error("categorical: total weight must be > 0");
  let r = randomFloat(rng) * total;
  for (const c of choices) {
    r -= Math.max(c.weight, 0);
    if (r <= 0) return c.value;
  }
  return choices[choices.length - 1]!.value;
}
