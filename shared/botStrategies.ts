// JSON-safe bot descriptions shared by the setup UI and server strategies.
// Never import the executable server registry into browser components.
import type { BotStrategy } from "../server/bots/api";

type StrategyMetadata = Pick<BotStrategy,
  "id" | "displayName" | "description" | "tags" | "category" |
  "paramsSchema" | "defaultProfileDistributions"
>;

export const NOOP_METADATA = {
  id: "noop",
  displayName: "No-op (does nothing)",
} satisfies StrategyMetadata;

export const RANDOM_QUOTER_METADATA = {
  id: "random-quoter",
  displayName: "Random quoter (fixed spread)",
  description:
    "Quotes a symmetric two-sided spread around mid (falling back to last trade, then the configured fallback) on every contract. Requotes on a timer and cancels at every information event.",
  tags: ["market-maker", "noise", "template"],
  category: "market-maker",
  paramsSchema: {
    spread: {
      kind: "int", min: 1, max: 50, default: 2,
      label: "Spread (half-width)",
      description: "Distance from mid to each quoted price.",
    },
    size: {
      kind: "int", min: 1, max: 100, default: 1,
      label: "Quote size",
      description: "Quantity placed at each side per requote.",
    },
    requoteMs: {
      kind: "int", min: 250, max: 60000, default: 5000,
      label: "Requote interval (ms)",
      description: "Cadence between full requotes.",
    },
    fallbackMid: {
      kind: "int", min: 1, max: 100, default: 25,
      label: "Fallback mid",
      description: "Used when neither book mid nor last trade exist.",
    },
  },
} satisfies StrategyMetadata;

export const NATURAL_PLAYER_METADATA = {
  id: "natural-player",
  displayName: "Natural Player",
  description: "Discretionary trader filling a signed target across four behavioral phases.",
  category: "directional",
  // lagMs comes from the spawner's `profile.lagMs` (consumed via
  // subCtx.afterLag); it is intentionally not a strategy param.
  paramsSchema: {
    targetQty: { kind: "int", default: 5, label: "Target qty (signed; >0 buy, <0 sell)" },
    tightSpreadFrac: { kind: "number", default: 1, min: 0 },
    widthInitTicks: { kind: "int", default: 3, min: 1 },
    // Absolute cap on the width budget, in ticks. Original meaning was a
    // multiplier on the historic median BAS; now it's a hard tick ceiling
    // chosen at draw time from a distribution informed by what BAS values
    // a game tends to show. Keeps the budget bounded without depending
    // on observing the historic median first.
    historicMedianGuard: { kind: "number", default: 8, min: 0 },
    urgencyDecayPerSec: { kind: "number", default: 0.05, min: 0 },
    idleSecondsBeforeDecay: { kind: "number", default: 1.0, min: 0 },
    urgentPennyIntervalMs: { kind: "int", default: 1000, min: 100 },
    panicThreshold: { kind: "number", default: 1.5, min: 0 },
    panicEmaHalfLifeSec: { kind: "number", default: 5, min: 0.1 },
  },

  defaultProfileDistributions: {
    count: { kind: "uniform-int", min: 1, max: 5 },
    spawn: { mode: "poisson", ratePerSec: { kind: "uniform", min: 0.01, max: 0.1 } },
    lagMs: { kind: "uniform-int", min: 1000, max: 3000 },
    scope: "instance",
    params: {
      targetQty: { kind: "uniform-int", min: 1, max: 5 },
      tightSpreadFrac: { kind: "uniform", min: 1, max: 2 },
      widthInitTicks: { kind: "uniform-int", min: 1, max: 5 },
      historicMedianGuard: { kind: "uniform", min: 5, max: 10 },
      urgencyDecayPerSec: { kind: "uniform", min: 0, max: 0.4 },
      idleSecondsBeforeDecay: { kind: "uniform", min: 4, max: 10 },
      urgentPennyIntervalMs: { kind: "categorical", choices: [
        { value: 1000, weight: 1 }, { value: 2000, weight: 1 }, { value: 3000, weight: 1 },
      ] },
      panicThreshold: { kind: "gaussian", mean: 5, std: 3, min: 0, max: 10 },
      panicEmaHalfLifeSec: { kind: "uniform", min: 10, max: 60 },
    },
  },
} satisfies StrategyMetadata;

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

const CATALOGUE: readonly StrategyMetadata[] = [
  NOOP_METADATA,
  RANDOM_QUOTER_METADATA,
  NATURAL_PLAYER_METADATA,
];

export function listStrategies(): readonly StrategyInfo[] {
  return CATALOGUE.map((s) => ({
    id: s.id,
    displayName: s.displayName,
    description: s.description ?? null,
    tags: s.tags ?? [],
    category: s.category ?? null,
    paramsSchema: s.paramsSchema ?? null,
    defaultProfileDistributions: s.defaultProfileDistributions ?? null,
  }));
}
