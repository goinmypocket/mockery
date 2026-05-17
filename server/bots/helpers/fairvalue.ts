// =============================================================================
// Fair-value helpers — size-weighted mid + EMAs that handle a null
// fair value (one-sided book) by decaying weight without distorting
// the central estimate. Time EMA: 1-second self-ticker. Volume EMA:
// caller pumps from onTrade with the trade qty.
// =============================================================================

import type { ContractId } from "../../../shared/ids";
import { contractDistribution } from "../../../engine/distribution";
import type { BookSnapshot, BotContext, MarketSnapshot, TimerHandle } from "../api";

/** Unconditional expected payoff for a contract using the deck and
 *  game shape from the snapshot, conditioned on whatever public cards
 *  have already been revealed. Returns null if the contract isn't in
 *  the snapshot. Useful as an EMA seed / fair-value prior. */
export function contractPrior(snap: MarketSnapshot, contractId: ContractId): number | null {
  const contract = snap.contracts.find((c) => c.id === contractId);
  if (!contract) return null;
  const informedSeats = snap.participants.reduce((n, p) => n + (p.role === "informed" ? 1 : 0), 0);
  const knownPublic: Record<number, number> = {};
  for (let i = 0; i < snap.publicCards.length; i++) {
    const v = snap.publicCards[i];
    if (v !== null && v !== undefined) knownPublic[i] = v;
  }
  const { mean } = contractDistribution({
    cardValues: snap.cardValues,
    copiesPerValue: snap.copiesPerValue,
    informedSeats,
    publicSlots: snap.publicCards.length,
    payoffSource: contract.payoffSource,
    knownPublic,
  });
  return Number.isFinite(mean) ? mean : null;
}

/** Microprice. Null when either side is empty or total touch size is 0. */
export function weightedMid(book: BookSnapshot): number | null {
  const bid = book.bids[0], offer = book.offers[0];
  if (!bid || !offer) return null;
  const total = bid.size + offer.size;
  if (total <= 0) return null;
  return (bid.price * offer.size + offer.price * bid.size) / total;
}

// ---------------------------------------------------------------------------
// EMA primitives. State = (weightedSum, totalWeight); decay scales
// both, preserving the central value while confidence drops. A null
// observation just decays — that's how the EMA survives a one-sided
// book without lying about the mid.
// ---------------------------------------------------------------------------

export interface EmaState { weightedSum: number; totalWeight: number }

export function newEma(): EmaState { return { weightedSum: 0, totalWeight: 0 }; }

export function emaValue(s: EmaState): number | null {
  return s.totalWeight > 0 ? s.weightedSum / s.totalWeight : null;
}

export function emaDecay(s: EmaState, factor: number): void {
  s.weightedSum *= factor; s.totalWeight *= factor;
}

export function emaObserve(s: EmaState, value: number, weight = 1): void {
  s.weightedSum += value * weight; s.totalWeight += weight;
}

export function emaStep(s: EmaState, value: number | null, decay: number, weight = 1): void {
  emaDecay(s, decay);
  if (value !== null) emaObserve(s, value, weight);
}

export function decayForHalfLife(halfLife: number): number {
  return Math.pow(0.5, 1 / Math.max(halfLife, 1e-9));
}

// ---------------------------------------------------------------------------

export interface EmaHandle {
  get(): number | null;
  weight(): number;
  stop(): void;
}

/** Optional starting observation. `value: null` is ignored — handy for
 *  `{ seed: { value: contractPrior(snap, cid), weight: 5 } }` where the
 *  prior may not be computable yet. Weight defaults to 1. */
export interface EmaSeed {
  readonly value: number | null;
  readonly weight?: number;
}

function seedState(state: EmaState, seed: EmaSeed | undefined): void {
  if (seed && seed.value !== null) emaObserve(state, seed.value, seed.weight ?? 1);
}

const TIME_STATE = "__timeEma:state:";
const TIME_TIMER = "__timeEma:timer:";

export function timeEma(
  ctx: BotContext,
  key: string,
  halfLifeSec: number,
  sample: () => number | null,
  opts?: { seed?: EmaSeed },
): EmaHandle {
  const stateKey = TIME_STATE + key, timerKey = TIME_TIMER + key;
  const prior = ctx.local.get(timerKey) as TimerHandle | undefined;
  if (prior !== undefined) ctx.clearTimer(prior);
  const state = newEma();
  seedState(state, opts?.seed);
  ctx.local.set(stateKey, state);
  const decay = decayForHalfLife(halfLifeSec);
  const tick = (): void => {
    emaStep(state, sample(), decay, 1);
    ctx.local.set(timerKey, ctx.setTimer(1000, tick));
  };
  ctx.local.set(timerKey, ctx.setTimer(1000, tick));
  return {
    get: () => emaValue(state),
    weight: () => state.totalWeight,
    stop: () => {
      const h = ctx.local.get(timerKey) as TimerHandle | undefined;
      if (h !== undefined) { ctx.clearTimer(h); ctx.local.delete(timerKey); }
    },
  };
}

const VOLUME_STATE = "__volumeEma:";

export interface VolumeEmaHandle extends EmaHandle {
  /** Decay = 0.5^(qty / halfLifeVolume); null value decays only. */
  update(value: number | null, qty: number): void;
}

export function volumeEma(
  ctx: BotContext,
  key: string,
  halfLifeVolume: number,
  opts?: { seed?: EmaSeed },
): VolumeEmaHandle {
  const state = newEma();
  seedState(state, opts?.seed);
  ctx.local.set(VOLUME_STATE + key, state);
  const safeHalf = Math.max(halfLifeVolume, 1e-9);
  return {
    get: () => emaValue(state),
    weight: () => state.totalWeight,
    stop: () => {},
    update: (value, qty) => emaStep(state, value, Math.pow(0.5, qty / safeHalf), qty),
  };
}
