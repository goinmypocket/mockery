// =============================================================================
// natural-player — discretionary trader filling a target qty across
// four phases: spawn-sweep, initiate (passive penny), take (cross),
// urgent (panic-driven). See docs/bots/natural-player.md for the spec.
//
// v1 limitation: scope is treated as "shared" — progress is measured
// against the bot entity's myPosition delta from spawn. Concurrent
// same-direction instances on the same bot will therefore all close
// when the first instance's target is hit. Proper per-instance
// attribution needs the engine to surface buyer/seller resting
// order IDs on Trade (separate change).
// =============================================================================

import type { ContractId, OrderId } from "../../../shared/ids";
import type { BotStrategy } from "../api";
import type { SubBotContext } from "../spawning";
import type { EmaHandle } from "../helpers/fairvalue";
import {
  contractPrior, marketWidth, quantile, secondsSinceLastAction,
  TimeSeries, timeEma, weightedMid,
} from "../helpers";

const TICK = 1;             // mockery uses integer prices
const STATE_KEY = "natural-player:state";
const BAS_AGE_MS = 30 * 60 * 1000;
const LAST_PENNY_KEY = "natural-player:lastPennyAt";

type Phase = "spawn-sweep" | "initiate" | "take" | "urgent" | "done";

interface State {
  cid: ContractId;
  direction: "buy" | "sell";
  targetQty: number;       // absolute
  instanceFilled: number;  // qty filled by THIS instance's orders (signed by direction)
  phase: Phase;
  widthBudget: number;     // in ticks; decays with idleness
  lastBudgetUpdateTs: number;
  ema: EmaHandle;
}

const naturalPlayer: BotStrategy = {
  id: "natural-player",
  displayName: "Natural Player",
  description: "Discretionary trader filling a signed target across four behavioral phases.",
  category: "directional",
  // lagMs comes from the spawner's `profile.lagMs` (consumed via
  // subCtx.afterLag); it is intentionally not a strategy param.
  paramsSchema: {
    targetQty: { kind: "int", default: 5, label: "Target qty (signed; >0 buy, <0 sell)" },
    tightSpreadFrac: { kind: "number", default: 0.5, min: 0, max: 1 },
    widthInitTicks: { kind: "int", default: 3, min: 1 },
    historicMedianGuard: { kind: "number", default: 1.5, min: 0 },
    urgencyDecayPerSec: { kind: "number", default: 0.05, min: 0 },
    idleSecondsBeforeDecay: { kind: "number", default: 1.0, min: 0 },
    urgentPennyIntervalMs: { kind: "int", default: 1000, min: 100 },
    panicThreshold: { kind: "number", default: 1.5, min: 0 },
    panicEmaHalfLifeSec: { kind: "number", default: 5, min: 0.1 },
  },

  onStart(ctx) {
    const sub = ctx as SubBotContext;
    if (typeof sub.afterLag !== "function" || typeof sub.close !== "function") {
      throw new Error("natural-player must be hosted by multiProfileBot (needs SubBotContext)");
    }
    if (ctx.snapshot.contracts.length === 0) { sub.close(); return; }
    const cid = ctx.snapshot.contracts[0]!.id;

    const targetSigned = ctx.params.targetQty as number;
    if (targetSigned === 0) { sub.close(); return; }
    const direction: "buy" | "sell" = targetSigned > 0 ? "buy" : "sell";

    // Shared BAS time series — one per contract, populated by all
    // natural-player instances under this bot.
    const basKey = `natural-player:bas:${cid}`;
    let bas = sub.shared.get(basKey) as TimeSeries<number> | undefined;
    if (!bas) { bas = new TimeSeries<number>(BAS_AGE_MS); sub.shared.set(basKey, bas); }

    // EMA seeded with the contract prior so the panic comparison is
    // defined from the start. Sample is the weighted-mid; null when
    // one-sided, which decays the EMA weight (see fairvalue.ts).
    const prior = contractPrior(ctx.snapshot, cid);
    const ema = timeEma(
      sub,
      `natural-player:ema:${sub.profileId}`,
      ctx.params.panicEmaHalfLifeSec as number,
      () => {
        const book = sub.snapshot.books[cid];
        return book ? weightedMid(book) : null;
      },
      prior !== null ? { seed: { value: prior, weight: 3 } } : undefined,
    );

    const state: State = {
      cid, direction,
      targetQty: Math.abs(targetSigned),
      instanceFilled: 0,
      phase: "spawn-sweep",
      widthBudget: ctx.params.widthInitTicks as number,
      lastBudgetUpdateTs: ctx.snapshot.ts,
      ema,
    };
    sub.local.set(STATE_KEY, state);

    // Phase 1 fires after the action lag.
    sub.afterLag(() => runSpawnSweep(sub, state));
  },

  onMyFill(ctx, trade) {
    const sub = ctx as SubBotContext;
    const state = sub.local.get(STATE_KEY) as State | undefined;
    if (!state || state.phase === "done") return;
    // Attribute only fills against THIS instance's resting orders.
    // Aggressor-side fills were already recorded synchronously from
    // the placement's return value.
    if (sub.myOrderIds.has(trade.restingOrderId)) {
      recordFills(state, [{ qty: trade.qty }]);
    }
  },

  onMarketData(ctx) {
    const sub = ctx as SubBotContext;
    const state = sub.local.get(STATE_KEY) as State | undefined;
    if (!state || state.phase === "done") return;

    // Push BAS sample; populates the shared quantile / median series.
    const book = ctx.snapshot.books[state.cid];
    if (book) {
      const w = marketWidth(book);
      if (w !== null) {
        const bas = sub.shared.get(`natural-player:bas:${state.cid}`) as TimeSeries<number>;
        bas.push(ctx.snapshot.ts, w);
      }
    }

    if (remainingQty(sub, state) <= 0) { closeInstance(sub, state); return; }
    if (state.phase === "spawn-sweep") return;     // wait for the lag-deferred kickoff
    drive(sub, state);
  },
};

export default naturalPlayer;

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function remainingQty(_sub: SubBotContext, state: State): number {
  return Math.max(0, state.targetQty - state.instanceFilled);
}

function recordFills(state: State, fills: ReadonlyArray<{ qty: number }>): void {
  for (const f of fills) state.instanceFilled += f.qty;
}

function closeInstance(sub: SubBotContext, state: State): void {
  state.phase = "done";
  state.ema.stop();
  for (const o of sub.myOpenOrders()) {
    if (o.contractId === state.cid && sub.myOrderIds.has(o.id)) sub.cancel(o.id);
  }
  sub.close();
}

function basQuantile(sub: SubBotContext, state: State, q: number): number | null {
  const bas = sub.shared.get(`natural-player:bas:${state.cid}`) as TimeSeries<number>;
  return quantile(bas.valuesWithin(sub.snapshot.ts), q);
}

// ---------------------------------------------------------------------------
// Phase 1: spawn sweep
// ---------------------------------------------------------------------------

function runSpawnSweep(sub: SubBotContext, state: State): void {
  if (state.phase !== "spawn-sweep") return;
  const book = sub.snapshot.books[state.cid];
  if (!book) { state.phase = "initiate"; return; }

  const q25 = basQuantile(sub, state, 0.25);
  if (q25 === null) {
    // No history yet — passive join, then continue into Phase 2 so the
    // strategy doesn't sit idle waiting for the next market tick.
    placePassive(sub, state, bestOurSidePrice(sub, state));
    state.phase = "initiate";
    drive(sub, state);
    return;
  }

  const threshold = Math.max((sub.params.tightSpreadFrac as number) * q25, TICK);
  const currentBas = marketWidth(book) ?? Infinity;
  if (currentBas <= threshold) sweepTake(sub, state, threshold);
  state.phase = "initiate";
  if (remainingQty(sub, state) > 0) drive(sub, state);
  else closeInstance(sub, state);
}

function sweepTake(sub: SubBotContext, state: State, threshold: number): void {
  const book = sub.snapshot.books[state.cid];
  if (!book) return;
  const ladder = state.direction === "buy" ? book.offers : book.bids;
  const refPx = state.direction === "buy" ? book.bids[0]?.price : book.offers[0]?.price;
  if (refPx === undefined) return;

  let remaining = remainingQty(sub, state);
  for (const level of ladder) {
    if (remaining <= 0) break;
    const within = state.direction === "buy"
      ? level.price <= refPx + threshold
      : level.price >= refPx - threshold;
    if (!within) break;
    const qty = Math.min(remaining, level.size);
    const r = sub.placeIoc({ contractId: state.cid, side: state.direction, qty, price: level.price });
    if (r.ok && "fills" in r.value) recordFills(state, r.value.fills);
    remaining -= qty;
  }
}

// ---------------------------------------------------------------------------
// Drive: routes to phase-specific handler
// ---------------------------------------------------------------------------

function drive(sub: SubBotContext, state: State): void {
  decayWidthBudget(sub, state);

  if (state.widthBudget < TICK && state.phase === "initiate") state.phase = "urgent";

  if (state.phase === "initiate") drivePhase2(sub, state);
  else if (state.phase === "urgent") drivePhase4(sub, state);
  else if (state.phase === "take") drivePhase3(sub, state);
}

function decayWidthBudget(sub: SubBotContext, state: State): void {
  const idle = secondsSinceLastAction(sub.snapshot, state.cid);
  if (idle === null) return;
  const grace = sub.params.idleSecondsBeforeDecay as number;
  if (idle < grace) return;
  const dt = (sub.snapshot.ts - state.lastBudgetUpdateTs) / 1000;
  state.lastBudgetUpdateTs = sub.snapshot.ts;
  const decay = (sub.params.urgencyDecayPerSec as number) * dt;
  state.widthBudget = Math.max(0, state.widthBudget - decay);
}

// ---------------------------------------------------------------------------
// Phase 2: initiate (passive penny)
// ---------------------------------------------------------------------------

function drivePhase2(sub: SubBotContext, state: State): void {
  const book = sub.snapshot.books[state.cid];
  if (!book) return;

  const others = othersBestPrice(sub, state, book);
  const opposite = state.direction === "buy" ? book.offers[0]?.price : book.bids[0]?.price;
  if (others === null || opposite === undefined) {
    // Nothing to penny against; just join if we can.
    placePassive(sub, state, others ?? opposite ?? null);
    return;
  }

  // Width from us to the opposite touch.
  const width = state.direction === "buy" ? opposite - others : others - opposite;
  const cappedBudget = capByHistoricMedian(sub, state, state.widthBudget);

  if (width > cappedBudget) {
    // Threshold breached — cross over.
    state.phase = "take";
    drivePhase3(sub, state);
    return;
  }

  const newPx = state.direction === "buy" ? others + TICK : others - TICK;
  placePassive(sub, state, newPx);
}

function capByHistoricMedian(sub: SubBotContext, state: State, budgetTicks: number): number {
  const med = basQuantile(sub, state, 0.5);
  if (med === null) return budgetTicks;
  const guard = sub.params.historicMedianGuard as number;
  return Math.min(budgetTicks, (guard * med) / TICK);
}

function placePassive(sub: SubBotContext, state: State, price: number | null): void {
  if (price === null || !Number.isFinite(price)) return;
  const existing = ownActiveOrder(sub, state);
  if (existing && existing.price === price) return;
  if (existing) sub.cancel(existing.id);
  const qty = remainingQty(sub, state);
  if (qty <= 0) return;
  sub.afterLag(() => {
    const stillNeeded = remainingQty(sub, state);
    if (stillNeeded <= 0 || state.phase === "done") return;
    const r = sub.placeLimit({ contractId: state.cid, side: state.direction, qty: stillNeeded, price });
    if (r.ok && "fills" in r.value) recordFills(state, r.value.fills);
  });
}

// ---------------------------------------------------------------------------
// Phase 3: take
// ---------------------------------------------------------------------------

function drivePhase3(sub: SubBotContext, state: State): void {
  const book = sub.snapshot.books[state.cid];
  if (!book) return;
  const opposite = state.direction === "buy" ? book.offers[0] : book.bids[0];
  if (!opposite) return;
  const remaining = remainingQty(sub, state);
  if (remaining <= 0) { closeInstance(sub, state); return; }
  cancelOwn(sub, state);
  sub.afterLag(() => {
    const stillNeeded = remainingQty(sub, state);
    if (stillNeeded <= 0 || state.phase === "done") return;
    const r = sub.placeIoc({ contractId: state.cid, side: state.direction, qty: stillNeeded, price: opposite.price });
    if (r.ok && "fills" in r.value) recordFills(state, r.value.fills);
  });
}

// ---------------------------------------------------------------------------
// Phase 4: urgent
// ---------------------------------------------------------------------------

function drivePhase4(sub: SubBotContext, state: State): void {
  const book = sub.snapshot.books[state.cid];
  if (!book) return;

  // Panic check.
  const currentPx = book.lastTradePrice
    ?? (state.direction === "buy" ? book.bids[0]?.price : book.offers[0]?.price)
    ?? null;
  if (currentPx !== null) {
    const ema = state.ema.get();
    if (ema !== null) {
      const diff = currentPx - ema;
      const threshold = sub.params.panicThreshold as number;
      const panic = state.direction === "buy" ? diff > threshold : diff < -threshold;
      if (panic) { drivePhase3(sub, state); return; }
    }
  }

  // Throttled penny.
  const interval = sub.params.urgentPennyIntervalMs as number;
  const last = (sub.local.get(LAST_PENNY_KEY) as number | undefined) ?? 0;
  if (sub.snapshot.ts - last < interval) return;
  sub.local.set(LAST_PENNY_KEY, sub.snapshot.ts);

  const ourSide = bestOurSidePrice(sub, state);
  if (ourSide === null) return;
  const newPx = state.direction === "buy" ? ourSide + TICK : ourSide - TICK;
  placePassive(sub, state, newPx);
}

// ---------------------------------------------------------------------------
// Touch helpers (filter our own orders out where the spec asks)
// ---------------------------------------------------------------------------

function bestOurSidePrice(sub: SubBotContext, state: State): number | null {
  const book = sub.snapshot.books[state.cid];
  if (!book) return null;
  return state.direction === "buy" ? (book.bids[0]?.price ?? null) : (book.offers[0]?.price ?? null);
}

/** Best price on our side (buy → bids, sell → offers) contributed by
 *  any party other than ourselves. Used for pennying — we don't want
 *  to penny our own resting order. */
function othersBestPrice(
  sub: SubBotContext,
  state: State,
  book: NonNullable<SubBotContext["snapshot"]["books"][ContractId]>,
): number | null {
  const myCode = sub.myCode;
  const levels = state.direction === "buy" ? book.bids : book.offers;
  for (const lvl of levels) {
    if (lvl.parties.some((p) => p.code !== myCode)) return lvl.price;
  }
  return null;
}

function ownActiveOrder(sub: SubBotContext, state: State): { id: OrderId; price: number } | null {
  for (const o of sub.myOpenOrders()) {
    if (o.contractId !== state.cid) continue;
    if (o.side !== state.direction) continue;
    if (!sub.myOrderIds.has(o.id)) continue;
    return { id: o.id, price: o.price };
  }
  return null;
}

function cancelOwn(sub: SubBotContext, state: State): void {
  for (const o of sub.myOpenOrders()) {
    if (o.contractId === state.cid && sub.myOrderIds.has(o.id)) sub.cancel(o.id);
  }
}
