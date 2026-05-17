// =============================================================================
// Market-state helpers and historical-statistics primitives.
//
//  - `isMarketSafe(book)` / `marketWidth(book)` — instantaneous touch queries
//    that return null (or false) when the book is one-sided.
//  - `TimeSeries<T>` — ring buffer of (ts, value) pairs with age + size
//    caps; the bot pushes samples from `onTrade` / `onBookUpdate` /
//    `cadence`, and reducers (`mean`, `median`, `quantile`, `stdev`,
//    `fractionTruthy`) compute rolling stats over windows.
//
// All numeric reducers skip `null` so a one-sided book just shrinks
// the sample count for that window rather than poisoning the stat.
// =============================================================================

import type { ContractId } from "../../../shared/ids";
import type { BookSnapshot, MarketSnapshot } from "../api";

// ---------------------------------------------------------------------------
// Touch queries
// ---------------------------------------------------------------------------

/** True iff both sides of the touch carry non-zero size. */
export function isMarketSafe(book: BookSnapshot): boolean {
  const bid = book.bids[0], offer = book.offers[0];
  return !!bid && !!offer && bid.size > 0 && offer.size > 0;
}

/** best offer − best bid. Null if either side is empty. */
export function marketWidth(book: BookSnapshot): number | null {
  const bid = book.bids[0], offer = book.offers[0];
  if (!bid || !offer) return null;
  return offer.price - bid.price;
}

/** Seconds since the last trade in `contractId` (looking at the
 *  snapshot's `recentTrades`). Null if no trades for this contract
 *  are in the window. Use as the "patience" signal for urgency-decaying
 *  strategies. */
export function secondsSinceLastAction(snap: MarketSnapshot, contractId: ContractId): number | null {
  for (let i = snap.recentTrades.length - 1; i >= 0; i--) {
    const t = snap.recentTrades[i]!;
    if (t.contractId === contractId) return (snap.ts - t.ts) / 1000;
  }
  return null;
}

// ---------------------------------------------------------------------------
// TimeSeries<T> — sliding-window ring buffer.
// ---------------------------------------------------------------------------

export interface TimeSample<T> { readonly ts: number; readonly value: T }

export class TimeSeries<T> {
  private buf: TimeSample<T>[] = [];
  constructor(
    private readonly maxAgeMs: number,
    private readonly maxSamples = 10_000,
  ) {}

  push(ts: number, value: T): void {
    this.buf.push({ ts, value });
    this.trim(ts);
  }

  /** Samples within the last `ms` (default: every sample still in the
   *  buffer). Caller passes the current time so the helper stays pure
   *  w.r.t. wall clock. */
  within(now: number, ms?: number): readonly TimeSample<T>[] {
    if (ms === undefined) return this.buf.slice();
    const cutoff = now - ms;
    const i = lowerBound(this.buf, cutoff);
    return this.buf.slice(i);
  }

  /** Just the values, no timestamps. */
  valuesWithin(now: number, ms?: number): T[] {
    return this.within(now, ms).map((s) => s.value);
  }

  size(): number { return this.buf.length; }
  clear(): void { this.buf.length = 0; }

  private trim(now: number): void {
    const cutoff = now - this.maxAgeMs;
    while (this.buf.length > 0 && this.buf[0]!.ts < cutoff) this.buf.shift();
    while (this.buf.length > this.maxSamples) this.buf.shift();
  }
}

function lowerBound<T>(buf: readonly TimeSample<T>[], cutoff: number): number {
  let lo = 0, hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (buf[mid]!.ts < cutoff) lo = mid + 1; else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Pure reducers — all null-skipping.
// ---------------------------------------------------------------------------

function nonNull(xs: ReadonlyArray<number | null>): number[] {
  const out: number[] = [];
  for (const x of xs) if (x !== null) out.push(x);
  return out;
}

export function mean(xs: ReadonlyArray<number | null>): number | null {
  const ys = nonNull(xs);
  return ys.length === 0 ? null : ys.reduce((a, b) => a + b, 0) / ys.length;
}

export function median(xs: ReadonlyArray<number | null>): number | null {
  return quantile(xs, 0.5);
}

export function quantile(xs: ReadonlyArray<number | null>, q: number): number | null {
  const ys = nonNull(xs).sort((a, b) => a - b);
  if (ys.length === 0) return null;
  const pos = (ys.length - 1) * Math.min(Math.max(q, 0), 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return ys[lo]!;
  return ys[lo]! + (ys[hi]! - ys[lo]!) * (pos - lo);
}

export function stdev(xs: ReadonlyArray<number | null>): number | null {
  const ys = nonNull(xs);
  if (ys.length < 2) return null;
  const m = ys.reduce((a, b) => a + b, 0) / ys.length;
  const v = ys.reduce((a, b) => a + (b - m) * (b - m), 0) / ys.length;
  return Math.sqrt(v);
}

/** Fraction of samples that are truthy. Used for "% of time market
 *  was safe" by pushing booleans (or 1/0) into the series. */
export function fractionTruthy(xs: ReadonlyArray<unknown>): number {
  if (xs.length === 0) return 0;
  let n = 0;
  for (const x of xs) if (x) n++;
  return n / xs.length;
}
