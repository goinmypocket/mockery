// =============================================================================
// random-quoter — quotes a fixed-width spread around the current mid (or a
// fallback) for every contract, refreshed every `requoteMs`. Cancels its
// quotes on every event (the information regime has changed).
//
// Educational only. Don't trade against this for real money.
// =============================================================================

import type { BotStrategy } from "../api";

const REQUOTE_MS = 5000;
const SPREAD = 2;
const SIZE = 1;
const FALLBACK_MID = 25;

const randomQuoter: BotStrategy = {
  id: "random-quoter",
  displayName: "Random quoter (fixed spread)",

  onStart(ctx) {
    const tick = (): void => {
      requote(ctx);
      const handle = ctx.setTimer(REQUOTE_MS, tick);
      ctx.local.set("timer", handle);
    };
    tick();
  },

  onEvent(ctx) {
    ctx.cancelAllMy();
  },

  onGameOver(ctx) {
    const handle = ctx.local.get("timer");
    if (handle) ctx.clearTimer(handle as never);
  },
};

function requote(ctx: Parameters<NonNullable<BotStrategy["onStart"]>>[0]): void {
  ctx.cancelAllMy();
  for (const c of ctx.snapshot.contracts) {
    const mid = ctx.snapshot.books[c.id]?.midPrice
      ?? ctx.snapshot.books[c.id]?.lastTradePrice
      ?? FALLBACK_MID;
    const bid = Math.floor(mid - SPREAD);
    const offer = Math.ceil(mid + SPREAD);
    if (bid > 0) {
      ctx.placeLimit({ contractId: c.id, side: "buy",  qty: SIZE, price: bid });
    }
    ctx.placeLimit({ contractId: c.id, side: "sell", qty: SIZE, price: offer });
  }
}

export default randomQuoter;
