// =============================================================================
// Position / cash bookkeeping and mark-to-market PnL.
//
// On every fill the engine credits/debits both sides:
//   buyer:  position += qty,  cash -= price * qty
//   seller: position -= qty,  cash += price * qty
//
// Marks: mid if both sides quoted, else lastTradePrice, else 0.
// MTM = position * mark + cash.
// =============================================================================

import type { ContractId } from "../shared/ids";
import type { ParticipantId, Trade } from "../shared/types";
import { participantKey } from "../shared/types";
import type { GameState } from "./state";
import { midPrice } from "./orderBook";

export function applyTrade(state: GameState, trade: Trade): void {
  applyLeg(state, trade.buyer, trade.contractId, +trade.qty, -trade.price * trade.qty);
  applyLeg(state, trade.seller, trade.contractId, -trade.qty, +trade.price * trade.qty);
}

function applyLeg(
  state: GameState,
  who: ParticipantId,
  contractId: ContractId,
  posDelta: number,
  cashDelta: number,
): void {
  const k = participantKey(who);
  if (!state.positions[k]) state.positions[k] = {};
  state.positions[k]![contractId] = (state.positions[k]![contractId] ?? 0) + posDelta;
  state.cash[k] = (state.cash[k] ?? 0) + cashDelta;
}

export function getPosition(
  state: GameState,
  who: ParticipantId,
  contractId: ContractId,
): number {
  return state.positions[participantKey(who)]?.[contractId] ?? 0;
}

export function getCash(state: GameState, who: ParticipantId): number {
  return state.cash[participantKey(who)] ?? 0;
}

/** Mark used for MTM PnL during play. Mid > last > 0. */
export function markPrice(state: GameState, contractId: ContractId): number {
  const book = state.books[contractId];
  if (!book) return 0;
  const mid = midPrice(book);
  if (mid !== null) return mid;
  return book.lastTradePrice ?? 0;
}

export function mtmPnl(state: GameState, who: ParticipantId): number {
  const k = participantKey(who);
  const positions = state.positions[k];
  let pnl = state.cash[k] ?? 0;
  if (!positions) return pnl;
  for (const [contractId, pos] of Object.entries(positions)) {
    pnl += pos * markPrice(state, contractId as ContractId);
  }
  return pnl;
}

/** Settled PnL: replaces marks with provided settlement values. */
export function settledPnl(
  state: GameState,
  who: ParticipantId,
  settlements: Record<ContractId, number>,
): number {
  const k = participantKey(who);
  const positions = state.positions[k];
  let pnl = state.cash[k] ?? 0;
  if (!positions) return pnl;
  for (const [contractId, pos] of Object.entries(positions)) {
    const settle = settlements[contractId as ContractId] ?? 0;
    pnl += pos * settle;
  }
  return pnl;
}
