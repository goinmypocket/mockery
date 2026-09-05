// =============================================================================
// Bot strategy registry. Each entry binds a string id (used in the
// host's setup picker and in SETUP_BIND_BOT_STRATEGY) to a BotStrategy.
//
// Adding a strategy = create a file under ./strategies/ that exports
// a BotStrategy as `default`, then add one entry below and its metadata
// to shared/botStrategies.ts (the browser-safe catalogue). The
// `validateRegistry()` call at module load asserts every strategy's
// `id` matches its registry key — a misregistered or mis-imported
// strategy fails fast at module init rather than at game start.
// =============================================================================

import type { AnyBotStrategy } from "./api";
import noop from "./strategies/noop";
import randomQuoter from "./strategies/random-quoter";
import naturalPlayer from "./strategies/natural-player";

export const STRATEGIES: Readonly<Record<string, AnyBotStrategy>> = Object.freeze({
  noop: noop as AnyBotStrategy,
  "random-quoter": randomQuoter as AnyBotStrategy,
  "natural-player": naturalPlayer as AnyBotStrategy,
});

export type StrategyId = keyof typeof STRATEGIES;

// Keep the server API compatible; the catalogue has no executable strategies.
export { listStrategies, type StrategyInfo } from "../../shared/botStrategies";

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
