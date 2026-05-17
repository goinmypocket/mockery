// =============================================================================
// Bot configuration: parametric specs that get drawn into concrete
// Profiles at game-setup time. See docs/bot-spawning-model.md §4–5.
//
// At setup, the host writes a `BotConfigSpec` — distributions for
// every numeric parameter. `drawProfiles(spec, rng)` consumes the
// engine's seeded RNG and returns the `Profile[]` that
// `multiProfileBot` expects. Same seed → same draws, so games replay
// with identical bot behavior.
// =============================================================================

import { sample, sampleAll, type Distribution } from "../../engine/sampling";
import type { Rng } from "../../engine/rng";
import type { BotStrategy } from "./api";
import type { Profile } from "./spawning";

export interface StrategySpec {
  /** Inner strategy template; e.g. naturalPlayer. */
  readonly strategy: BotStrategy;
  /** How many profiles of this kind to draw. Rounded to a non-negative int. */
  readonly count: Distribution;
  /** Whether each drawn profile is permanent or Poisson-spawning. For
   *  Poisson, ratePerSec is itself a distribution drawn per profile. */
  readonly spawn:
    | { readonly mode: "permanent" }
    | { readonly mode: "poisson"; readonly ratePerSec: Distribution };
  readonly lagMs: Distribution;
  readonly scope: "instance" | "shared";
  /** Per-profile parameter distributions. Each profile gets an
   *  independent draw of every key. */
  readonly params: Readonly<Record<string, Distribution>>;
}

export interface BotConfigSpec {
  readonly strategies: readonly StrategySpec[];
}

/** JSON-friendly form: same shape but references a strategy by id
 *  instead of holding the object. Used by wire / save formats. */
export interface WireStrategySpec extends Omit<StrategySpec, "strategy"> {
  readonly strategyId: string;
}

export interface WireBotConfigSpec {
  readonly strategies: readonly WireStrategySpec[];
}

/** Resolve a wire spec against a registry. Throws if any `strategyId`
 *  isn't found. */
export function resolveWireSpec(
  wire: WireBotConfigSpec,
  registry: Readonly<Record<string, BotStrategy>>,
): BotConfigSpec {
  return {
    strategies: wire.strategies.map((ws) => {
      const strategy = registry[ws.strategyId];
      if (!strategy) throw new Error(`unknown strategyId "${ws.strategyId}"`);
      const { strategyId: _id, ...rest } = ws;
      return { ...rest, strategy };
    }),
  };
}

/** Draw a concrete Profile[] from a BotConfigSpec. Each StrategySpec
 *  contributes `sample(count)` profiles; per-profile params, lag, and
 *  spawn-rate are drawn independently. Profile IDs are
 *  `<strategy.id>#<n>` so they're identifiable in the action log. */
export function drawProfiles(spec: BotConfigSpec, rng: Rng): Profile[] {
  const out: Profile[] = [];
  for (const ss of spec.strategies) {
    const count = Math.max(0, Math.round(sample(ss.count, rng)));
    for (let i = 0; i < count; i++) {
      const params = sampleAll(ss.params, rng);
      const lagMs = Math.max(0, Math.round(sample(ss.lagMs, rng)));
      const spawn: Profile["spawn"] =
        ss.spawn.mode === "permanent"
          ? { mode: "permanent" }
          : { mode: "poisson", ratePerSec: Math.max(0, sample(ss.spawn.ratePerSec, rng)) };
      out.push({
        id: `${ss.strategy.id}#${out.length}`,
        strategy: ss.strategy,
        params,
        spawn,
        lagMs,
        scope: ss.scope,
      });
    }
  }
  return out;
}

/** Convenience: resolve a wire spec then draw. */
export function drawProfilesFromWire(
  wire: WireBotConfigSpec,
  registry: Readonly<Record<string, BotStrategy>>,
  rng: Rng,
): Profile[] {
  return drawProfiles(resolveWireSpec(wire, registry), rng);
}
