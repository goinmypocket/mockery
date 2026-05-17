// =============================================================================
// Quoting helpers. Patterns for converting a center price + spread +
// size into a list of price-level intents a market-making strategy
// can iterate and place. Pure functions; the strategy decides what
// to do with the output (place all, cap at a position limit, etc.).
// =============================================================================

import type { OrderSide } from "../../../shared/types";

export interface Quote {
  readonly side: OrderSide;
  readonly price: number;
  readonly qty: number;
}

/** Symmetric two-sided quote at `center ± halfSpread`, single level
 *  per side. Floors the bid and ceils the offer so integer-price
 *  markets always get crossed-protected quotes. */
export function twoSided(
  center: number,
  halfSpread: number,
  size: number,
): { bid: Quote; offer: Quote } {
  return {
    bid: { side: "buy", price: Math.floor(center - halfSpread), qty: size },
    offer: { side: "sell", price: Math.ceil(center + halfSpread), qty: size },
  };
}

/** N-level ladder around a center price. Bids step down by `step`
 *  starting at `Math.floor(center - halfSpread)`; offers step up by
 *  `step` starting at `Math.ceil(center + halfSpread)`. `size` is
 *  the per-level quantity. Returns the flattened list — caller
 *  filters / orders / places as it sees fit. */
export function ladder(args: {
  center: number;
  halfSpread: number;
  step: number;
  levels: number;
  size: number;
}): readonly Quote[] {
  const { center, halfSpread, step, levels, size } = args;
  const out: Quote[] = [];
  const baseBid = Math.floor(center - halfSpread);
  const baseOffer = Math.ceil(center + halfSpread);
  for (let i = 0; i < levels; i++) {
    const bidPrice = baseBid - i * step;
    if (bidPrice > 0) {
      out.push({ side: "buy", price: bidPrice, qty: size });
    }
    out.push({ side: "sell", price: baseOffer + i * step, qty: size });
  }
  return out;
}

/** Clamp a quoted size against a position limit. Strategies that
 *  want hard inventory caps wrap their quote sizes through this:
 *  bids shrink toward zero as long position approaches +limit, and
 *  offers shrink as short position approaches -limit. Returns the
 *  truncated qty (≥ 0). */
export function sizeUnderLimit(args: {
  side: OrderSide;
  baseQty: number;
  myPosition: number;
  positionLimit: number;
}): number {
  const { side, baseQty, myPosition, positionLimit } = args;
  if (baseQty <= 0) return 0;
  if (side === "buy") {
    const room = positionLimit - myPosition;
    if (room <= 0) return 0;
    return Math.min(baseQty, room);
  }
  const room = positionLimit + myPosition;
  if (room <= 0) return 0;
  return Math.min(baseQty, room);
}
