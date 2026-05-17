// =============================================================================
// random-quoter — quotes a fixed-width spread around the current mid
// (or a fallback) for every contract, refreshed on a cadence. Cancels
// its quotes on every event (the information regime has changed).
//
// Educational only. Don't trade against this for real money.
//
// Demonstrates the modular bot API:
//   - paramsSchema → host can tune spread / size / cadence per
//     instance without copying the file.
//   - cadence() helper → owns the setTimer re-arm pattern.
//   - midOrFallback() + twoSided() helpers → no inline math.
//   - onEvent → cancel quotes at the information boundary.
// =============================================================================

import type { BotContext, BotStrategy } from "../api";
import {
  cadence,
  midOrFallback,
  twoSided,
} from "../helpers";

/** Params live as a type alias rather than an interface so it
 *  trivially satisfies the open `Record<string, unknown>` index
 *  signature TypeScript expects everywhere a strategy is stored
 *  alongside others (registry, orchestrator). Closed interfaces
 *  break that index-signature check; the type alias here is
 *  equivalent in everything but variance. */
type QuoterParams = Readonly<{
  spread: number;
  size: number;
  requoteMs: number;
  fallbackMid: number;
}>;

const randomQuoter: BotStrategy<QuoterParams> = {
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

  onStart(ctx) {
    cadence(ctx, ctx.params.requoteMs, () => requote(ctx));
  },

  onEvent(ctx) {
    ctx.cancelAllMy();
  },
};

function requote(ctx: BotContext<QuoterParams>): void {
  ctx.cancelAllMy();
  const { spread, size, fallbackMid } = ctx.params;
  for (const c of ctx.snapshot.contracts) {
    const mid = midOrFallback(ctx.snapshot, c.id, fallbackMid);
    if (mid === null) continue;
    const { bid, offer } = twoSided(mid, spread, size);
    if (bid.price > 0) {
      ctx.placeLimit({ contractId: c.id, side: bid.side, qty: bid.qty, price: bid.price });
    }
    ctx.placeLimit({ contractId: c.id, side: offer.side, qty: offer.qty, price: offer.price });
  }
}

export default randomQuoter;
