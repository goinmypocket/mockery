// =============================================================================
// Bot orchestrator. Owns the per-game lifecycle of bot instances:
//   - on enter playing: instantiate one BotInstance per bot entity that
//     has a strategy bound, call onStart.
//   - on every state change (trade, event, market change): build a fresh
//     MarketSnapshot for each bot, refresh its BotContext, call the
//     appropriate callback.
//   - on game over: call onGameOver, cancel pending bot timers, drop
//     all instances.
//
// The orchestrator hooks into MockerySession via SessionHooks. Bot
// actions go back into the session through `submitBotIntent` and
// `cancelAllForBot`. Re-entrancy (a bot's action triggering another
// state change which would recursively notify the same bot) is bounded
// by a depth cap with deferred re-dispatch.
// =============================================================================

import type {
  ContractId,
  OrderId,
  TableId,
} from "../../shared/ids";
import type {
  GameEvent,
  Order,
  ParticipantId,
  Trade,
} from "../../shared/types";
import { participantKey } from "../../shared/types";
import {
  type MarketSnapshot,
  type BookSnapshot,
  type BotContext,
  type BotStrategy,
  type BotTrade,
  type GameResult,
  type LevelSnapshot,
  type OpResult,
  type ParticipantSummary,
  type PlaceArgs,
  type TimerHandle,
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
  readonly entityId: string;
  readonly strategy: BotStrategy;
  readonly local: Map<string, unknown>;
  readonly timers: Set<TimerHandle>;
  errorCount: number;
  context: BotContext;
}

export class BotOrchestrator {
  private instances = new Map<string, BotInstance>();
  private dispatching = false;
  private pendingMarketChange = false;
  private depth = 0;

  constructor(
    private readonly session: MockerySession,
    private readonly clock: SessionClock,
    private readonly strategies: Readonly<Record<string, BotStrategy>>,
  ) {
    const hooks: SessionHooks = {
      onEnterPlaying: () => this.onEnterPlaying(),
      onTrades: (trades) => this.onTrades(trades),
      onEvent: (event) => this.onEvent(event),
      onMarketChanged: () => this.onMarketChanged(),
      onGameOver: () => this.onGameOver(),
    };
    session.setHooks(hooks);
  }

  // -------------------------------------------------------------------
  // Hook receivers
  // -------------------------------------------------------------------

  private onEnterPlaying(): void {
    const state = this.session.getEngineState();
    for (const e of state.botEntities) {
      if (!e.strategyId) continue;
      const strat = this.strategies[e.strategyId];
      if (!strat) continue;
      this.instantiate(e.entityId, strat);
    }
    for (const inst of this.instances.values()) {
      this.callOnStart(inst);
    }
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
      for (const t of projected) {
        this.dispatchTo(inst, () => inst.strategy.onTrade?.(inst.context, t));
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
        for (const inst of this.instances.values()) {
          this.refreshContext(inst);
          this.dispatchTo(inst, () =>
            inst.strategy.onMarketData?.(inst.context, inst.context.snapshot),
          );
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

  private instantiate(entityId: string, strategy: BotStrategy): void {
    const inst: BotInstance = {
      entityId,
      strategy,
      local: new Map(),
      timers: new Set(),
      errorCount: 0,
      context: undefined as unknown as BotContext,   // set by refreshContext
    };
    this.instances.set(entityId, inst);
    this.refreshContext(inst);
  }

  private refreshContext(inst: BotInstance): void {
    const ctx: BotContext = {
      entityId: inst.entityId,
      tableId: this.session.tableId as TableId,
      snapshot: this.buildSnapshotFor(inst.entityId),

      placeLimit: (args: PlaceArgs) => this.actionPlace(inst, args, /* ioc */ false),
      placeIoc:   (args: PlaceArgs) => this.actionPlace(inst, args, /* ioc */ true),
      cancel:     (orderId: OrderId) => this.actionCancel(inst, orderId),
      cancelAllMy: () => this.actionCancelAll(inst),

      myPosition: (cid: ContractId) =>
        getPosition(this.session.getEngineState(), this.botParticipant(inst.entityId), cid),
      myCash: () =>
        getCash(this.session.getEngineState(), this.botParticipant(inst.entityId)),
      myMtmPnl: () =>
        mtmPnl(this.session.getEngineState(), this.botParticipant(inst.entityId)),
      myOpenOrders: () => this.collectMyOpenOrders(inst.entityId),

      local: inst.local,
      setTimer: (ms, fn) => {
        const handle = this.clock.schedule(ms, () => {
          inst.timers.delete(handle);
          this.dispatchTo(inst, fn);
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
    const r = this.session.submitBotIntent(inst.entityId, {
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

  private actionCancel(inst: BotInstance, orderId: OrderId): OpResult<void> {
    const r = this.session.submitBotIntent(inst.entityId, {
      type: "CANCEL_ORDER",
      orderId,
    });
    if (!r.ok) return { ok: false, reason: r.reason };
    return { ok: true } as OpResult<void>;
  }

  private actionCancelAll(inst: BotInstance): OpResult<{ cancelled: number }> {
    const r = this.session.cancelAllForBot(inst.entityId);
    return { ok: true, value: r.value };
  }

  // -------------------------------------------------------------------
  // Snapshot / projection helpers
  // -------------------------------------------------------------------

  private buildSnapshotFor(entityId: string): MarketSnapshot {
    const state = this.session.getEngineState();

    const codeFor = (id: ParticipantId): string =>
      state.codeBook[participantKey(id)] ?? "??";

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

    const myParticipant = this.botParticipant(entityId);
    const myKey = participantKey(myParticipant);
    const myPositionsFull = state.positions[myKey] ?? {};
    const myPositions: Record<ContractId, number> = { ...myPositionsFull };
    const myCash = state.cash[myKey] ?? 0;
    const myMtmPnl = mtmPnl(state, myParticipant);
    const myOpenOrders = this.collectMyOpenOrders(entityId);

    const msUntilNextEvent =
      state.nextEventAt !== null ? Math.max(0, state.nextEventAt - this.clock.now()) : null;

    return {
      ts: this.clock.now(),
      phase: state.phase,
      status: state.status === "finished" ? "finished" : "playing",
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
      myMtmPnl,
      myOpenOrders,
    };
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
