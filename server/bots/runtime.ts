// =============================================================================
// Bot orchestrator. Owns the per-game lifecycle of bot instances:
//   - on enter playing: resolve each entity's strategy + params, build
//     a BotInstance, call onStart.
//   - on every engine state change: build a fresh MarketSnapshot for
//     each bot, refresh its BotContext, fire the appropriate
//     callbacks (onMarketData, onBookUpdate per dirty contract,
//     onPhaseChange when phase advances).
//   - on every trade batch: project trades into BotTrade shape, fan
//     out onTrade to all bots, and additionally fire onMyFill to the
//     bot that was party to each fill.
//   - on game over: call onGameOver, cancel pending bot timers, drop
//     all instances.
//
// The orchestrator hooks into MockerySession via SessionHooks. Bot
// actions go back into the session through `submitBotIntent` and
// `cancelAllForBot`. Re-entrancy is bounded by a depth cap with
// deferred re-dispatch; throws are counted per instance and a bot is
// quarantined after 5 failures.
// =============================================================================

import type {
  ContractId,
  OrderId,
  TableId,
} from "../../shared/ids";
import type {
  GameEvent,
  Order,
  OrderBook,
  ParticipantId,
  Trade,
} from "../../shared/types";
import { participantKey } from "../../shared/types";
import type { BotStateSnapshot } from "../../shared/types";
import { deriveSeed, makeRng } from "../../engine/rng";
import { unsafeUniformIntDistribution } from "pure-rand";
import { drawProfilesFromWire, type WireBotConfigSpec } from "./config";
import { multiProfileBot } from "./spawning";
import {
  type AnyBotStrategy,
  type MarketSnapshot,
  type BookSnapshot,
  type BotContext,
  type BotTrade,
  type GameResult,
  type LevelSnapshot,
  type OpResult,
  type Params,
  type ParticipantSummary,
  type PlaceArgs,
  type TimerHandle,
  resolveParams,
} from "./api";
import { getCash, getPosition, mtmPnl } from "../../engine/pnl";
import { midPrice } from "../../engine/orderBook";
import type {
  MockerySession,
  SessionHooks,
} from "../MockerySession";
import type { SessionClock } from "../clock";

const MAX_REENTRY_DEPTH = 8;

interface BotInstance {
  /** Primary key — entityId for standalone, groupId for groups. */
  readonly entityId: string;
  /** Engine-level entities this instance acts on / receives fills for.
   *  Length 1 for standalone; length N for groups (multi-code). */
  readonly entityIds: readonly string[];
  readonly strategy: AnyBotStrategy;
  readonly params: Params;
  readonly local: Map<string, unknown>;
  readonly timers: Set<TimerHandle>;
  errorCount: number;
  context: BotContext;
  lastPhase: number;
  bookFingerprints: Map<ContractId, string>;
  /** Seeded RNG used to pick a routing entity per `actionPlace` when
   *  `entityIds.length > 1`. Same seed → same routing sequence
   *  → replayable. Undefined for standalone instances. */
  routingRng?: import("../../engine/rng").Rng;
}

export class BotOrchestrator {
  private instances = new Map<string, BotInstance>();
  private dispatching = false;
  private pendingMarketChange = false;
  private depth = 0;

  private readonly groups: readonly import("./api").BotGroupConfig[];

  constructor(
    private readonly session: MockerySession,
    private readonly clock: SessionClock,
    private readonly strategies: Readonly<Record<string, AnyBotStrategy>>,
    opts?: { readonly groups?: readonly import("./api").BotGroupConfig[] },
  ) {
    this.groups = opts?.groups ?? [];
    const hooks: SessionHooks = {
      onEnterPlaying: () => this.onEnterPlaying(),
      onTrades: (trades) => this.onTrades(trades),
      onEvent: (event) => this.onEvent(event),
      onMarketChanged: () => this.onMarketChanged(),
      onGameOver: () => this.onGameOver(),
      botStateProvider: () => this.captureBotStates(),
    };
    session.setHooks(hooks);
  }

  /** Snapshot every live bot's params and scratchpad. Called by the
   *  session when it appends an entry to the action log so each entry
   *  carries the bot state at that instant. The `local` Map is
   *  projected to a plain object; values that can't survive a JSON
   *  round-trip are replaced with a placeholder so the log stays
   *  serializable. */
  captureBotStates(): readonly BotStateSnapshot[] {
    const out: BotStateSnapshot[] = [];
    for (const inst of this.instances.values()) {
      out.push({
        entityId: inst.entityId,
        strategyId: inst.strategy.id,
        params: jsonSafeClone(inst.params),
        local: jsonSafeFromMap(inst.local),
      });
    }
    return out;
  }

  // -------------------------------------------------------------------
  // Hook receivers
  // -------------------------------------------------------------------

  private onEnterPlaying(): void {
    const state = this.session.getEngineState();
    const baseSeed = state.options.seed;
    const claimed = new Set<string>();

    // Helper: resolve & instantiate any spec source (group or entity).
    const launch = (
      label: string,
      key: string,
      entityIds: readonly string[],
      src: SourceSpec,
    ): boolean => {
      try {
        const r = resolveSource(this.strategies, baseSeed, key, src);
        if (!r) return false;
        this.instantiateForKey(key, entityIds.slice(), r);
        return true;
      } catch (err) {
        console.warn(`[${label}:${key}] invalid (${(err as Error).message}); skipping`);
        return false;
      }
    };

    // 1. Groups (constructor-time programmatic + state-side wire).
    for (const g of this.groups) {
      if (launch("bot-group", g.groupId, g.entityIds, g)) {
        for (const eid of g.entityIds) claimed.add(eid);
      }
    }
    for (const g of state.botGroups) {
      const src: SourceSpec = {
        strategyId: g.strategyId,
        params: g.params,
        config: g.config as unknown as WireBotConfigSpec | undefined,
        ...(typeof g.seed === "number" ? { seed: g.seed } : {}),
      };
      if (launch("bot-group", g.groupId, g.entityIds, src)) {
        for (const eid of g.entityIds) claimed.add(eid);
      }
    }

    // 2. Standalone entities (skip those claimed by a group).
    for (const e of state.botEntities) {
      if (claimed.has(e.entityId)) continue;
      launch("bot", e.entityId, [e.entityId], {
        strategyId: e.strategyId,
        params: e.params,
        config: e.config as unknown as WireBotConfigSpec | undefined,
      });
    }

    for (const inst of this.instances.values()) this.callOnStart(inst);
  }

  private onMarketChanged(): void {
    if (this.dispatching) {
      this.pendingMarketChange = true;
      return;
    }
    this.dispatchMarketData();
  }

  private onTrades(trades: readonly Trade[]): void {
    if (trades.length === 0) return;
    const projected = trades.map((t) => this.projectTrade(t));
    for (const inst of this.instances.values()) {
      for (let i = 0; i < projected.length; i++) {
        const t = projected[i]!;
        const raw = trades[i]!;
        this.dispatchTo(inst, () => inst.strategy.onTrade?.(inst.context, t));
        // onMyFill: cheap participant compare against the raw trade.
        // The buyer/seller participant ids carry kind+entityId, so we
        // don't need any code-table lookups here.
        const buyerIsMe =
          raw.buyer.kind === "bot" && inst.entityIds.includes(raw.buyer.entityId);
        const sellerIsMe =
          raw.seller.kind === "bot" && inst.entityIds.includes(raw.seller.entityId);
        if (buyerIsMe) {
          this.dispatchTo(inst, () =>
            inst.strategy.onMyFill?.(inst.context, t, "buy"),
          );
        }
        if (sellerIsMe) {
          this.dispatchTo(inst, () =>
            inst.strategy.onMyFill?.(inst.context, t, "sell"),
          );
        }
      }
    }
  }

  private onEvent(event: GameEvent): void {
    for (const inst of this.instances.values()) {
      this.dispatchTo(inst, () => inst.strategy.onEvent?.(inst.context, event));
    }
  }

  private onGameOver(): void {
    for (const inst of this.instances.values()) {
      this.dispatchTo(inst, () =>
        inst.strategy.onGameOver?.(inst.context, this.buildResultFor(inst)),
      );
    }
    for (const inst of this.instances.values()) {
      for (const handle of inst.timers) this.clock.cancel(handle);
      inst.timers.clear();
    }
    this.instances.clear();
  }

  // -------------------------------------------------------------------
  // Dispatch core
  // -------------------------------------------------------------------

  private dispatchMarketData(): void {
    if (this.depth >= MAX_REENTRY_DEPTH) return;
    this.depth++;
    try {
      do {
        this.pendingMarketChange = false;
        // Compute the current per-contract book fingerprints once,
        // shared across all instances. Each instance compares against
        // its own last-seen map so two bots can be at different
        // points in the tick without losing onBookUpdate firings.
        const currentBookFps = this.computeBookFingerprints();
        for (const inst of this.instances.values()) {
          this.refreshContext(inst);
          // onMarketData — coarse, always fires on any change.
          this.dispatchTo(inst, () =>
            inst.strategy.onMarketData?.(inst.context, inst.context.snapshot),
          );
          // onBookUpdate — fine, fires per contract whose fingerprint
          // changed since this instance's last seen tick.
          for (const [contractId, fp] of currentBookFps) {
            if (inst.bookFingerprints.get(contractId) !== fp) {
              inst.bookFingerprints.set(contractId, fp);
              this.dispatchTo(inst, () =>
                inst.strategy.onBookUpdate?.(inst.context, contractId),
              );
            }
          }
          // onPhaseChange — fires once whenever the phase counter
          // advances. We track per-instance so a quarantined bot
          // re-entering wouldn't accidentally skip a phase.
          const phase = inst.context.snapshot.phase;
          if (phase !== inst.lastPhase) {
            const old = inst.lastPhase;
            inst.lastPhase = phase;
            this.dispatchTo(inst, () =>
              inst.strategy.onPhaseChange?.(inst.context, old, phase),
            );
          }
        }
      } while (this.pendingMarketChange && this.depth < MAX_REENTRY_DEPTH);
    } finally {
      this.depth--;
    }
  }

  private dispatchTo(inst: BotInstance, fn: () => void): void {
    if (this.session.getEngineState().status !== "playing"
        && this.session.getEngineState().status !== "finished") {
      return;
    }
    this.refreshContext(inst);
    this.dispatching = true;
    try {
      fn();
    } catch (err) {
      inst.errorCount++;
      if (inst.errorCount > 5) {
        // Quarantine: drop the instance so it stops receiving callbacks.
        for (const handle of inst.timers) this.clock.cancel(handle);
        inst.timers.clear();
        this.instances.delete(inst.entityId);
      }
      // Surface in dev; future pass: route through a TNS system row.
      console.warn(`[bot:${inst.entityId}] error:`, (err as Error).message);
    } finally {
      this.dispatching = false;
    }
  }

  private callOnStart(inst: BotInstance): void {
    this.dispatchTo(inst, () => inst.strategy.onStart?.(inst.context));
  }

  // -------------------------------------------------------------------
  // Instance & context construction
  // -------------------------------------------------------------------

  /** Unified instance build for both standalone bots and groups.
   *  Standalone passes `entityIds = [entityId]` and a no-op routing
   *  RNG; groups pass the full set. */
  private instantiateForKey(
    instanceKey: string,
    entityIds: string[],
    resolved: { strategy: AnyBotStrategy; params: Params; seed: number },
  ): void {
    if (entityIds.length === 0) throw new Error("instance has no entityIds");
    const inst: BotInstance = {
      entityId: instanceKey,
      entityIds,
      strategy: resolved.strategy,
      params: resolved.params,
      local: new Map(),
      timers: new Set(),
      errorCount: 0,
      context: undefined as unknown as BotContext,
      lastPhase: this.session.getEngineState().phase,
      bookFingerprints: this.computeBookFingerprints(),
      ...(entityIds.length > 1 ? { routingRng: makeRng(resolved.seed) } : {}),
    };
    this.instances.set(instanceKey, inst);
    this.refreshContext(inst);
  }

  /** Pick the entityId an action should route through. Standalone:
   *  the only id. Group: a uniform-random choice from `entityIds`,
   *  consuming the instance's seeded routing RNG. */
  private pickRoutingEntity(inst: BotInstance): string {
    if (inst.entityIds.length === 1 || !inst.routingRng) return inst.entityIds[0]!;
    const i = unsafeUniformIntDistribution(0, inst.entityIds.length - 1, inst.routingRng);
    return inst.entityIds[i]!;
  }

  private refreshContext(inst: BotInstance): void {
    const state = this.session.getEngineState();
    // Snapshot is built against the first entity (snapshot.myCode is
    // the primary). myCodes carries the full set so multi-code
    // strategies can self-identify orders under any of them.
    const primaryEntity = inst.entityIds[0]!;
    const snapshot = this.buildSnapshotFor(primaryEntity);
    const myCodes = inst.entityIds.map(
      (eid) => state.codeBook[participantKey({ kind: "bot", entityId: eid })] ?? eid,
    );
    const ctx: BotContext = {
      entityId: inst.entityId,
      tableId: this.session.tableId as TableId,
      snapshot,
      myCode: myCodes[0]!,
      myCodes,
      params: inst.params,

      placeLimit: (args: PlaceArgs) => this.actionPlace(inst, args, /* ioc */ false),
      placeIoc:   (args: PlaceArgs) => this.actionPlace(inst, args, /* ioc */ true),
      cancel:     (orderId: OrderId) => this.actionCancel(inst, orderId),
      cancelAllMy: () => this.actionCancelAll(inst),

      myPosition: (cid: ContractId) =>
        inst.entityIds.reduce((s, eid) =>
          s + getPosition(this.session.getEngineState(), this.botParticipant(eid), cid), 0),
      myCash: () =>
        inst.entityIds.reduce((s, eid) =>
          s + getCash(this.session.getEngineState(), this.botParticipant(eid)), 0),
      myMtmPnl: () =>
        inst.entityIds.reduce((s, eid) =>
          s + mtmPnl(this.session.getEngineState(), this.botParticipant(eid)), 0),
      myOpenOrders: () =>
        inst.entityIds.flatMap((eid) => this.collectMyOpenOrders(eid)),

      local: inst.local,
      setTimer: (ms, fn) => {
        const handle = this.clock.schedule(ms, () => {
          inst.timers.delete(handle);
          // dispatchTo refreshes inst.context first, so we pass the
          // fresh ctx into the callback rather than the (now stale)
          // one closed over at schedule time.
          this.dispatchTo(inst, () => fn(inst.context));
        });
        inst.timers.add(handle);
        return handle;
      },
      clearTimer: (handle) => {
        if (inst.timers.delete(handle)) this.clock.cancel(handle);
      },
    };
    inst.context = ctx;
  }

  // -------------------------------------------------------------------
  // Action API delegating to MockerySession
  // -------------------------------------------------------------------

  private actionPlace(
    inst: BotInstance,
    args: PlaceArgs,
    ioc: boolean,
  ): OpResult<{ orderId: OrderId | null; fills: BotTrade[] }> {
    const routed = this.pickRoutingEntity(inst);
    const r = this.session.submitBotIntent(routed, {
      type: ioc ? "PLACE_IOC" : "PLACE_LIMIT",
      contractId: args.contractId,
      side: args.side,
      qty: args.qty,
      price: args.price,
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    if ("cancelled" in r.value) return { ok: false, reason: "unexpected response shape" };
    const fills = r.value.fills.map((t) => this.projectTrade(t));
    return { ok: true, value: { orderId: r.value.orderId, fills } };
  }

  /** Cancel doesn't need routing — every order carries its owning
   *  entity, and `cancelOrder` finds it in any of the bot's books.
   *  We try each owned entity in order; first hit wins. */
  private actionCancel(inst: BotInstance, orderId: OrderId): OpResult<void> {
    for (const eid of inst.entityIds) {
      const r = this.session.submitBotIntent(eid, { type: "CANCEL_ORDER", orderId });
      if (r.ok) return { ok: true } as OpResult<void>;
    }
    return { ok: false, reason: "order not found or not yours" };
  }

  private actionCancelAll(inst: BotInstance): OpResult<{ cancelled: number }> {
    let total = 0;
    for (const eid of inst.entityIds) {
      total += this.session.cancelAllForBot(eid).value.cancelled;
    }
    return { ok: true, value: { cancelled: total } };
  }

  // -------------------------------------------------------------------
  // Snapshot / projection helpers
  // -------------------------------------------------------------------

  private buildSnapshotFor(entityId: string): MarketSnapshot {
    const state = this.session.getEngineState();

    const codeFor = (id: ParticipantId): string =>
      state.codeBook[participantKey(id)] ?? "??";

    const myParticipant = this.botParticipant(entityId);
    const myCode = codeFor(myParticipant);

    const participants: ParticipantSummary[] = [];
    for (let i = 0; i < state.seats.length; i++) {
      const u = state.seats[i];
      if (!u) continue;
      participants.push({
        code: state.codeBook[participantKey({ kind: "player", userId: u })] ?? "??",
        role: i < state.options.informedSeats ? "informed" : "uninformed",
        displayName: null,    // bots do not see display names
      });
    }
    for (const e of state.botEntities) {
      participants.push({
        code: state.codeBook[participantKey({ kind: "bot", entityId: e.entityId })] ?? e.entityId,
        role: "bot",
        displayName: null,
      });
    }

    const books: Record<ContractId, BookSnapshot> = {};
    for (const [cid, book] of Object.entries(state.books)) {
      const pl = (lvl: typeof book.bids[number]): LevelSnapshot => ({
        price: lvl.price,
        size: lvl.orders.reduce((acc, o) => acc + o.qty, 0),
        parties: lvl.orders.map((o) => ({ code: codeFor(o.participant), qty: o.qty })),
      });
      books[cid as ContractId] = {
        contractId: cid as ContractId,
        bids: book.bids.map(pl),
        offers: book.offers.map(pl),
        lastTradePrice: book.lastTradePrice,
        midPrice: midPrice(book),
      };
    }

    const recentTrades = state.trades.slice(-100).map((t) => this.projectTrade(t));

    const myKey = participantKey(myParticipant);
    const myPositionsFull = state.positions[myKey] ?? {};
    const myPositions: Record<ContractId, number> = { ...myPositionsFull };
    const myCash = state.cash[myKey] ?? 0;
    const myMtmPnlValue = mtmPnl(state, myParticipant);
    const myOpenOrders = this.collectMyOpenOrders(entityId);

    const msUntilNextEvent =
      state.nextEventAt !== null ? Math.max(0, state.nextEventAt - this.clock.now()) : null;

    return {
      ts: this.clock.now(),
      phase: state.phase,
      status: state.status === "finished" ? "finished" : "playing",
      myCode,
      cardValues: state.options.cardValues,
      copiesPerValue: state.options.copiesPerValue,
      publicCards: state.publicCards.map((v, i) => (state.publicRevealed[i] ? v : null)),
      contracts: state.contracts,
      participants,
      eventQueue: state.eventQueue,
      eventMode: state.options.eventMode,
      msUntilNextEvent,
      books,
      recentTrades,
      myPositions,
      myCash,
      myMtmPnl: myMtmPnlValue,
      myOpenOrders,
    };
  }

  /** Cheap per-contract fingerprint that captures the surface a
   *  market-making strategy cares about: top-of-book price + size on
   *  each side, plus the last trade price. Anything else (mid moves
   *  without a top change, deeper-than-best activity) deliberately
   *  doesn't fire onBookUpdate — those should arrive via onTrade or
   *  onMarketData instead. */
  private computeBookFingerprints(): Map<ContractId, string> {
    const out = new Map<ContractId, string>();
    const state = this.session.getEngineState();
    for (const [cid, book] of Object.entries(state.books)) {
      out.set(cid as ContractId, bookFingerprint(book));
    }
    return out;
  }

  private projectTrade(t: Trade): BotTrade {
    const state = this.session.getEngineState();
    const codeFor = (id: ParticipantId): string =>
      state.codeBook[participantKey(id)] ?? "??";
    return {
      id: t.id,
      ts: t.ts,
      phase: t.phase,
      contractId: t.contractId,
      buyerCode: codeFor(t.buyer),
      sellerCode: codeFor(t.seller),
      price: t.price,
      qty: t.qty,
      aggressor: t.aggressor,
      restingOrderId: t.restingOrderId,
    };
  }

  private buildResultFor(inst: BotInstance): GameResult {
    const state = this.session.getEngineState();
    const cards = [...state.informedCards, ...state.publicCards];
    const myKey = participantKey(this.botParticipant(inst.entityId));
    const myFinalPnl = state.finalPnl?.[myKey] ?? 0;
    return {
      cards,
      settlements: state.settlements ?? {},
      myFinalPnl,
    };
  }

  private collectMyOpenOrders(entityId: string): Order[] {
    const out: Order[] = [];
    for (const book of Object.values(this.session.getEngineState().books)) {
      for (const order of Object.values(book.ordersById)) {
        if (order.participant.kind === "bot" && order.participant.entityId === entityId) {
          out.push(order);
        }
      }
    }
    return out;
  }

  private botParticipant(entityId: string): ParticipantId {
    return { kind: "bot", entityId };
  }
}

/** JSON round-trip a value for the action log. Anything that throws
 *  (e.g. cycles, BigInt, functions, TimerHandle) is replaced with a
 *  string placeholder. */
function jsonSafeValue(v: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch {
    return `[non-serializable:${typeof v}]`;
  }
}

function jsonSafeClone(obj: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) out[k] = jsonSafeValue(v);
  return out;
}

function jsonSafeFromMap(map: Map<string, unknown>): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of map) out[k] = jsonSafeValue(v);
  return out;
}

/** Common shape for "what strategy + params should I run for this
 *  spec source?" Used for both standalone bot entities and groups. */
interface SourceSpec {
  readonly strategy?: AnyBotStrategy | undefined;
  readonly strategyId?: string | null | undefined;
  readonly params?: Readonly<Record<string, unknown>> | null | undefined;
  readonly config?: import("./config").WireBotConfigSpec | undefined;
  readonly seed?: number | undefined;
}

/** Resolve a spec source into (strategy, params, seed) ready to
 *  instantiate. Returns null if the source declares nothing runnable
 *  (e.g. strategyId is unset and config is missing). Throws on
 *  validation errors (unknown strategy id, invalid params, both
 *  strategy and config set). */
function resolveSource(
  strategies: Readonly<Record<string, AnyBotStrategy>>,
  baseSeed: number,
  keyForSeed: string,
  src: SourceSpec,
): { strategy: AnyBotStrategy; params: Params; seed: number } | null {
  const seed = src.seed ?? deriveSeed(baseSeed, keyForSeed);
  const hasStrategy = !!(src.strategy || src.strategyId);
  if (src.config && hasStrategy) throw new Error("specify exactly one of strategy / config");
  if (src.config) {
    const profiles = drawProfilesFromWire(src.config, strategies, makeRng(seed));
    return { strategy: multiProfileBot({ seed, profiles }), params: Object.freeze({}), seed };
  }
  const strategy = src.strategy ?? (src.strategyId ? strategies[src.strategyId] : undefined);
  if (!strategy) return null;
  const resolved = resolveParams(strategy.paramsSchema, src.params ?? null);
  if (!resolved.ok) throw new Error(`params invalid: ${resolved.reason}`);
  return { strategy, params: resolved.params, seed };
}


function bookFingerprint(book: OrderBook): string {
  const bb = book.bids[0];
  const bo = book.offers[0];
  const bbSize = bb ? bb.orders.reduce((s, o) => s + o.qty, 0) : 0;
  const boSize = bo ? bo.orders.reduce((s, o) => s + o.qty, 0) : 0;
  return [
    book.bids.length,
    bb?.price ?? "-",
    bbSize,
    book.offers.length,
    bo?.price ?? "-",
    boSize,
    book.lastTradePrice ?? "-",
  ].join("|");
}
