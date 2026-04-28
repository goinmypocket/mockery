// =============================================================================
// Bot strategy registry. Each entry binds a string id (used in the
// host's setup picker and in SETUP_BIND_BOT_STRATEGY) to a BotStrategy.
//
// Adding a strategy = creating a file under ./strategies/ and adding
// one entry here. See docs/bot-author-guide.md §3.
// =============================================================================

import type { BotStrategy } from "./api";
import noop from "./strategies/noop";
import randomQuoter from "./strategies/random-quoter";

export const STRATEGIES: Record<string, BotStrategy> = {
  noop,
  "random-quoter": randomQuoter,
};

export type StrategyId = keyof typeof STRATEGIES;

export function listStrategies(): readonly { id: string; displayName: string }[] {
  return Object.values(STRATEGIES).map((s) => ({
    id: s.id,
    displayName: s.displayName,
  }));
}
