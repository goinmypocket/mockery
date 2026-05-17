// =============================================================================
// Bot strategy registry. Each entry binds a string id (used in the
// host's setup picker and in SETUP_BIND_BOT_STRATEGY) to a BotStrategy.
//
// Adding a strategy = create a file under ./strategies/ that exports
// a BotStrategy as `default`, then add one entry below. The
// `validateRegistry()` call at module load asserts every strategy's
// `id` matches its registry key — a misregistered or mis-imported
// strategy fails fast at module init rather than at game start.
// =============================================================================

import type { AnyBotStrategy, BotStrategy } from "./api";
import noop from "./strategies/noop";
import randomQuoter from "./strategies/random-quoter";
import naturalPlayer from "./strategies/natural-player";

export const STRATEGIES: Readonly<Record<string, AnyBotStrategy>> = Object.freeze({
  noop: noop as AnyBotStrategy,
  "random-quoter": randomQuoter as AnyBotStrategy,
  "natural-player": naturalPlayer as AnyBotStrategy,
});

export type StrategyId = keyof typeof STRATEGIES;

/** Catalogue entry surfaced to the host UI. Includes everything the
 *  host needs to render a picker (id + display name + description +
 *  tags + category + params schema for the inline editor). The
 *  strategy itself is server-only; this is the JSON-safe summary. */
export interface StrategyInfo {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly tags: readonly string[];
  readonly category: string | null;
  readonly paramsSchema: BotStrategy<unknown>["paramsSchema"] | null;
  readonly defaultProfileDistributions:
    BotStrategy<unknown>["defaultProfileDistributions"] | null;
}

export function listStrategies(): readonly StrategyInfo[] {
  return Object.values(STRATEGIES).map((s) => ({
    id: s.id,
    displayName: s.displayName,
    description: s.description ?? null,
    tags: s.tags ?? [],
    category: s.category ?? null,
    paramsSchema: s.paramsSchema ?? null,
    defaultProfileDistributions: s.defaultProfileDistributions ?? null,
  }));
}

/** Throws if any strategy's `id` field doesn't match its registry
 *  key — i.e. someone imported the wrong file or typo'd a key.
 *  Called at module load so the failure surfaces during boot, not
 *  during the first game. */
export function validateRegistry(): void {
  for (const [key, strat] of Object.entries(STRATEGIES)) {
    if (strat.id !== key) {
      throw new Error(
        `bot registry: key "${key}" maps to a strategy whose own id is "${strat.id}" — fix the registry entry or the strategy's id`,
      );
    }
  }
}

validateRegistry();
