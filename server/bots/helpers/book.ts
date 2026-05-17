// =============================================================================
// Book / order helpers. Things every market-making and execution
// strategy reaches for: best bid/offer, mid resolution with a sane
// fallback chain, identifying the bot's own resting orders. Pure
// functions over MarketSnapshot — no engine internals, no I/O.
// =============================================================================

import type { ContractId, OrderId } from "../../../shared/ids";
import type { OrderSide } from "../../../shared/types";
import type {
  BookSnapshot,
  LevelSnapshot,
  MarketSnapshot,
} from "../api";

/** Returns the best (highest) bid level for a contract, or undefined
 *  if the book is one-sided / empty. */
export function bestBid(
  snap: MarketSnapshot,
  contractId: ContractId,
): LevelSnapshot | undefined {
  return snap.books[contractId]?.bids[0];
}

/** Returns the best (lowest) offer level for a contract, or undefined
 *  if the book is one-sided / empty. */
export function bestOffer(
  snap: MarketSnapshot,
  contractId: ContractId,
): LevelSnapshot | undefined {
  return snap.books[contractId]?.offers[0];
}

/** Top of book: best bid and best offer as a pair. Either side may be
 *  undefined. Convenience for `const { bid, offer } = touch(...)`. */
export function touch(
  snap: MarketSnapshot,
  contractId: ContractId,
): { bid: LevelSnapshot | undefined; offer: LevelSnapshot | undefined } {
  return { bid: bestBid(snap, contractId), offer: bestOffer(snap, contractId) };
}

/** Current spread (best offer − best bid). Returns null if either
 *  side is empty (no two-sided touch). */
export function spread(
  snap: MarketSnapshot,
  contractId: ContractId,
): number | null {
  const t = touch(snap, contractId);
  if (!t.bid || !t.offer) return null;
  return t.offer.price - t.bid.price;
}

/** Resolve a usable mid price for `contractId`: prefers the book's
 *  computed midPrice, falls back to the last trade price, then to a
 *  caller-supplied fallback. Returns null only when every fallback
 *  is exhausted. */
export function midOrFallback(
  snap: MarketSnapshot,
  contractId: ContractId,
  fallback?: number,
): number | null {
  const book = snap.books[contractId];
  if (book?.midPrice !== null && book?.midPrice !== undefined) return book.midPrice;
  if (book?.lastTradePrice !== null && book?.lastTradePrice !== undefined) {
    return book.lastTradePrice;
  }
  return fallback ?? null;
}

/** Total quantity the viewer is currently resting at `(contractId,
 *  side, price)`. Sums across multiple open orders the bot may have
 *  at the same level. Returns 0 if no such orders exist. */
export function myRestingAt(
  snap: MarketSnapshot,
  contractId: ContractId,
  side: OrderSide,
  price: number,
): number {
  let total = 0;
  for (const o of snap.myOpenOrders) {
    if (o.contractId !== contractId) continue;
    if (o.side !== side) continue;
    if (o.price !== price) continue;
    total += o.qty;
  }
  return total;
}

/** OrderIds of the viewer's resting orders at `(contractId, side,
 *  price)`. Useful for targeted cancels when you want to thin a
 *  level without nuking the whole book. */
export function myOrderIdsAt(
  snap: MarketSnapshot,
  contractId: ContractId,
  side: OrderSide,
  price: number,
): readonly OrderId[] {
  const out: OrderId[] = [];
  for (const o of snap.myOpenOrders) {
    if (o.contractId !== contractId) continue;
    if (o.side !== side) continue;
    if (o.price !== price) continue;
    out.push(o.id);
  }
  return out;
}

/** Walk every contract's book — small convenience so strategies can
 *  write `for (const book of allBooks(snap)) { ... }` without
 *  caring about the keyed Record shape. */
export function* allBooks(snap: MarketSnapshot): IterableIterator<BookSnapshot> {
  for (const book of Object.values(snap.books)) yield book;
}
