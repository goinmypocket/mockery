// =============================================================================
// Trade / tape helpers. Reading the recent trade log: identifying
// self-trades, time-weighting recent prices, basic signals.
// =============================================================================

import type { ContractId } from "../../../shared/ids";
import type { BotTrade, MarketSnapshot } from "../api";

/** True when the bot is party to this trade (either buyer or seller).
 *  Use this on `onTrade` callbacks; prefer `onMyFill` when only
 *  self-trades matter — the orchestrator filters cheaply there. */
export function isMyTrade(snap: MarketSnapshot, trade: BotTrade): boolean {
  return trade.buyerCode === snap.myCode || trade.sellerCode === snap.myCode;
}

/** Volume-weighted average price of the most recent `n` trades for
 *  `contractId`. Returns null if there are no trades to average. */
export function recentVwap(
  snap: MarketSnapshot,
  contractId: ContractId,
  n: number,
): number | null {
  let notional = 0;
  let qty = 0;
  // recentTrades is oldest→newest in the snapshot; walk from the end.
  for (let i = snap.recentTrades.length - 1; i >= 0 && qty < n; i--) {
    const t = snap.recentTrades[i]!;
    if (t.contractId !== contractId) continue;
    const take = Math.min(t.qty, n - qty);
    notional += t.price * take;
    qty += take;
  }
  if (qty === 0) return null;
  return notional / qty;
}

/** Last trade for a contract, or undefined if none has printed yet. */
export function lastTrade(
  snap: MarketSnapshot,
  contractId: ContractId,
): BotTrade | undefined {
  for (let i = snap.recentTrades.length - 1; i >= 0; i--) {
    const t = snap.recentTrades[i]!;
    if (t.contractId === contractId) return t;
  }
  return undefined;
}

/** Net signed volume over the most recent `n` trades for a contract.
 *  Positive when aggressor was the buyer (lifts) outnumber sells
 *  (hits). Useful as a crude momentum signal. */
export function netAggressorVolume(
  snap: MarketSnapshot,
  contractId: ContractId,
  n: number,
): number {
  let net = 0;
  let seen = 0;
  for (let i = snap.recentTrades.length - 1; i >= 0 && seen < n; i--) {
    const t = snap.recentTrades[i]!;
    if (t.contractId !== contractId) continue;
    net += t.aggressor === "buyer" ? t.qty : -t.qty;
    seen++;
  }
  return net;
}
