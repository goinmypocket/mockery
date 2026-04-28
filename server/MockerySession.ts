// =============================================================================
// MockerySession — implements the platform's GameSession seam.
//
// Responsibilities:
//   - Lobby seat management (claim/release/kick/start)
//   - Setup phase: contracts, queue, code book, bot entities, identity
//     reveal
//   - START_TRADING: deal cards, mint contract books, transition to
//     playing, arm event timer (auto mode)
//   - Play phase: order intents (PLACE_LIMIT/PLACE_IOC/CANCEL_ORDER) +
//     host-only queue / timer ops
//   - Auto-mode timer: fires events from the queue; on queue exhaust,
//     schedules a final settlement timer
//   - Manual-mode triggers: FIRE_NEXT_EVENT, END_GAME, START_GRACE_TIMER,
//     CANCEL_GRACE_TIMER
//   - Settlement at game end: reveal hidden cards, evaluate payoffs,
//     compute final PnL, transition to finished
//   - Per-recipient projection (engine/project.ts) for STATE_SNAPSHOT
//     broadcasts
//
// Bot orchestrator integration is stubbed (submitBotIntent) but its
// scheduling runtime lives in a separate module (server/bots/runtime.ts,
// to be added later).
// =============================================================================

import type {
  CreateOpts,
  GameSession,
  LoadOpts,
  Result,
  SeatOptions,
  SessionDescription,
} from "../shared/GameDefinition";
import {
  asContractId,
  asOrderId,
  asTradeId,
  type ContractId,
  type OrderId,
  type TableId,
  type UserId,
} from "../shared/ids";
import {
  isValidCode,
  participantKey,
  type BotEntity,
  type ContractDef,
  type EventMode,
  type EventQueueEntry,
  type IdentityReveal,
  type OrderSide,
  type ParticipantId,
  type ResolvedOptions,
  type Trade,
} from "../shared/types";
import {
  createInitialState,
  emptyBook,
  applyTrade,
  cancelOrder,
  placeOrder,
  rotateInformed,
  revealPublic,
  revealAllRemaining,
  deal,
  finalCardTuple,
  generateCodeBook,
  validateCode,
  validatePayoffSource,
  settleAll,
  settledPnl,
  type GameState,
  type ParticipantInfo,
} from "../engine";
import { project, type ProjectedSnapshot } from "../engine/project";
import { randomInt } from "../engine/rng";
import { realClock, type SessionClock, type TimerHandle } from "./clock";
import { getLibrary, type ContractLibrary } from "./db/library";
import { readResolved } from "./options";

/** Wider result type for `submitBotIntent` — the action API on
 *  `BotContext` needs the resident order id and fill list. */
export type BotIntentResult =
  | { ok: true; value: { orderId: import("../shared/ids").OrderId | null; fills: Trade[] } }
  | { ok: true; value: { cancelled: number } }
  | { ok: false; reason: string };

import type { GameEvent } from "../shared/types";

/** Observer hooks fired by the session after each state mutation. */
export interface SessionHooks {
  onEnterPlaying?(): void;
  onTrades?(trades: readonly Trade[]): void;
  onEvent?(event: GameEvent): void;
  onMarketChanged?(): void;
  onGameOver?(): void;
}

const SHARED_CONTRACTS_PATH = new URL("../config/shared-contracts.json", import.meta.url);

// ---------------------------------------------------------------------------
// Save / load
// ---------------------------------------------------------------------------

export interface MockerySave {
  readonly version: 1;
  readonly options: ResolvedOptions;
  readonly hostUserId: UserId;
  readonly seats: ReadonlyArray<UserId | null>;
  readonly seatDisplayNames: ReadonlyArray<string | null>;
  readonly status: "lobby" | "setup" | "playing" | "finished";
  // TODO(persistence): full state snapshot incl. rng, books, trades,
  //   positions, cash, codeBook, contracts, eventQueue, public cards.
}

export interface SessionConstructorArgs {
  readonly tableId: TableId;
  readonly hostUserId: UserId;
  readonly options: ResolvedOptions;
  readonly clock?: SessionClock;
  /** Override the user-contract-library implementation. Tests inject an
   *  in-memory variant; production uses the singleton from
   *  `./db/library.ts`. */
  readonly library?: ContractLibrary;
}

export function createFromOpts(opts: CreateOpts): MockerySession {
  return new MockerySession({
    tableId: opts.tableId,
    hostUserId: opts.hostUserId,
    options: readResolved(opts.options),
  });
}

export function loadFromOpts(blob: MockerySave, opts: LoadOpts): MockerySession {
  const s = new MockerySession({
    tableId: opts.tableId,
    hostUserId: blob.hostUserId,
    options: blob.options,
  });
  // TODO(persistence): hydrate full state.
  return s;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export class MockerySession implements GameSession<MockerySave> {
  readonly tableId: TableId;
  private state: GameState;
  private connections = new Map<UserId, (msg: unknown) => void>();
  private spectators = new Set<UserId>();
  private seatDisplayNames: (string | null)[];
  private clock: SessionClock;
  private lastActivityAt: number;

  /** Active event timer (auto mode only). The handle is stored so the
   *  host's DELAY/PREPONE/queue-mutation can cancel and re-arm. */
  private eventTimer: TimerHandle | null = null;
  /** Manual-mode optional grace timer (settles on fire). */
  private graceTimer: TimerHandle | null = null;
  /** Auto-mode end-of-game timer (the trailing interval after queue
   *  empties). */
  private endTimer: TimerHandle | null = null;

  /** Phase 1 of session lifecycle: while in platform lobby, describe()
   *  reports "lobby" regardless of engine state. */
  private inPlatformLobby = true;

  /** Hooks the bot orchestrator (or any other observer) registers against.
   *  All hooks fire AFTER the state has been updated, BEFORE
   *  `broadcastSnapshot`. Hooks must not throw. */
  private hooks: SessionHooks = {};

  /** Per-user contract library. Lazy: opened on first LIBRARY_* intent
   *  rather than at session construction so tests that don't touch the
   *  library don't pay the SQLite cost. */
  private libraryImpl: ContractLibrary | null;

  constructor(args: SessionConstructorArgs) {
    this.tableId = args.tableId;
    this.clock = args.clock ?? realClock;
    this.libraryImpl = args.library ?? null;
    const totalSeats = args.options.informedSeats + args.options.uninformedSeats;
    this.state = createInitialState({
      options: args.options,
      hostUserId: args.hostUserId,
      seats: new Array<UserId | null>(totalSeats).fill(null),
      now: this.clock.now(),
    });
    this.seatDisplayNames = new Array<string | null>(totalSeats).fill(null);
    this.lastActivityAt = this.clock.now();
  }

  private library(): ContractLibrary {
    if (!this.libraryImpl) this.libraryImpl = getLibrary();
    return this.libraryImpl;
  }

  // -------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------

  attachConnection(userId: UserId, send: (msg: unknown) => void): void {
    this.connections.set(userId, send);
    this.lastActivityAt = this.clock.now();
    if (this.state.seats.indexOf(userId) < 0 && userId !== this.state.hostUserId) {
      this.spectators.add(userId);
    }
    this.sendSnapshotTo(userId);
  }

  detachConnection(userId: UserId): void {
    this.connections.delete(userId);
    this.spectators.delete(userId);
    this.lastActivityAt = this.clock.now();
  }

  // -------------------------------------------------------------------
  // Lobby seat management
  // -------------------------------------------------------------------

  claimSeat(userId: UserId, seatIndex: number, options?: SeatOptions): Result {
    if (!this.inPlatformLobby) return { ok: false, reason: "game already started" };
    if (seatIndex < 0 || seatIndex >= this.state.seats.length) {
      return { ok: false, reason: "seat index out of range" };
    }
    const seats = this.state.seats;
    for (let i = 0; i < seats.length; i++) {
      if (seats[i] === userId) {
        seats[i] = null;
        this.seatDisplayNames[i] = null;
      }
    }
    if (seats[seatIndex] !== null) {
      return { ok: false, reason: "seat already taken" };
    }
    seats[seatIndex] = userId;
    this.seatDisplayNames[seatIndex] = options?.displayName ?? null;
    this.spectators.delete(userId);
    this.lastActivityAt = this.clock.now();
    this.broadcastSnapshot();
    return { ok: true };
  }

  releaseSeat(userId: UserId, seatIndex: number): Result {
    if (!this.inPlatformLobby) return { ok: false, reason: "game already started" };
    const seats = this.state.seats;
    if (seatIndex < 0 || seatIndex >= seats.length) {
      return { ok: false, reason: "seat index out of range" };
    }
    if (seats[seatIndex] !== userId) {
      return { ok: false, reason: "seat not held by caller" };
    }
    seats[seatIndex] = null;
    this.seatDisplayNames[seatIndex] = null;
    this.lastActivityAt = this.clock.now();
    this.broadcastSnapshot();
    return { ok: true };
  }

  kickSeat(callerUserId: UserId, seatIndex: number): Result {
    if (!this.inPlatformLobby) return { ok: false, reason: "game already started" };
    if (callerUserId !== this.state.hostUserId) {
      return { ok: false, reason: "only the host may kick" };
    }
    const seats = this.state.seats;
    if (seatIndex < 0 || seatIndex >= seats.length) {
      return { ok: false, reason: "seat index out of range" };
    }
    seats[seatIndex] = null;
    this.seatDisplayNames[seatIndex] = null;
    this.lastActivityAt = this.clock.now();
    this.broadcastSnapshot();
    return { ok: true };
  }

  /** Lobby → setup transition. Generates initial code book and seeds
   *  display names. The host configures the rest in setup. */
  startGame(callerUserId: UserId): Result {
    if (callerUserId !== this.state.hostUserId) {
      return { ok: false, reason: "only the host may start" };
    }
    if (!this.inPlatformLobby) return { ok: false, reason: "already started" };
    if (this.state.seats.some((s) => s === null)) {
      return { ok: false, reason: "all seats must be filled" };
    }

    // Capture display names into the engine's per-participant map.
    for (let i = 0; i < this.state.seats.length; i++) {
      const u = this.state.seats[i]!;
      const name = this.seatDisplayNames[i] ?? `Seat ${i + 1}`;
      this.state.displayNames[participantKey({ kind: "player", userId: u })] = name;
    }
    // Generate initial code book from current seats. Bot entities can
    // be added in setup and are appended to the code book at that time.
    this.state.codeBook = this.generateInitialCodeBook();

    this.inPlatformLobby = false;
    this.state.status = "setup";
    this.lastActivityAt = this.clock.now();
    this.broadcastSnapshot();
    return { ok: true };
  }

  // -------------------------------------------------------------------
  // Game messages — main router
  // -------------------------------------------------------------------

  handleGameMessage(userId: UserId, payload: unknown): void {
    this.lastActivityAt = this.clock.now();
    const msg = asObject(payload);
    if (!msg) return this.reject(userId, payload, "payload not an object");
    const kind = String(msg["type"] ?? "");

    try {
      switch (kind) {
        // Order-book intents — playing only.
        case "PLACE_LIMIT": return this.onPlace(userId, msg, /* ioc */ false);
        case "PLACE_IOC":   return this.onPlace(userId, msg, /* ioc */ true);
        case "CANCEL_ORDER": return this.onCancel(userId, msg);

        // Setup-phase intents — host only, status === "setup".
        case "SETUP_ADD_CONTRACT":         return this.onSetupAddContract(userId, msg);
        case "SETUP_REMOVE_CONTRACT":      return this.onSetupRemoveContract(userId, msg);
        case "SETUP_REPLACE_CONTRACT":     return this.onSetupReplaceContract(userId, msg);
        case "SETUP_IMPORT_CONTRACT":      return this.onSetupImportContract(userId, msg);
        case "SETUP_SET_BOT_ENTITIES":     return this.onSetupSetBotEntities(userId, msg);
        case "SETUP_BIND_BOT_STRATEGY":    return this.onSetupBindBotStrategy(userId, msg);
        case "SETUP_SET_EVENT_MODE":       return this.onSetupSetEventMode(userId, msg);
        case "SETUP_SET_CODE":             return this.onSetupSetCode(userId, msg);
        case "SETUP_RESHUFFLE_CODES":      return this.onSetupReshuffleCodes(userId);
        case "SETUP_SET_IDENTITY_REVEAL":  return this.onSetupSetIdentityReveal(userId, msg);
        case "SETUP_QUEUE_APPEND":         return this.onQueueAppend(userId, msg, /* setup */ true);
        case "SETUP_QUEUE_INSERT":         return this.onQueueInsert(userId, msg, /* setup */ true);
        case "SETUP_QUEUE_REMOVE":         return this.onQueueRemove(userId, msg, /* setup */ true);
        case "SETUP_QUEUE_MOVE":           return this.onQueueMove(userId, msg, /* setup */ true);
        case "START_TRADING":              return this.onStartTrading(userId);

        // Play-phase host intents — host only, status === "playing".
        case "QUEUE_APPEND":               return this.onQueueAppend(userId, msg, /* setup */ false);
        case "QUEUE_INSERT":               return this.onQueueInsert(userId, msg, /* setup */ false);
        case "QUEUE_REMOVE":               return this.onQueueRemove(userId, msg, /* setup */ false);
        case "QUEUE_MOVE":                 return this.onQueueMove(userId, msg, /* setup */ false);
        case "DELAY_NEXT_EVENT":           return this.onDelayNextEvent(userId, msg);
        case "PREPONE_NEXT_EVENT":         return this.onPreponeNextEvent(userId);
        case "FIRE_NEXT_EVENT":            return this.onFireNextEvent(userId);
        case "END_GAME":                   return this.onEndGame(userId);
        case "START_GRACE_TIMER":          return this.onStartGraceTimer(userId, msg);
        case "CANCEL_GRACE_TIMER":         return this.onCancelGraceTimer(userId);

        // Per-user contract library (any phase, any participant).
        case "LIBRARY_LIST":               return this.onLibraryList(userId);
        case "LIBRARY_SAVE":               return this.onLibrarySave(userId, msg);
        case "LIBRARY_UPDATE":             return this.onLibraryUpdate(userId, msg);
        case "LIBRARY_DELETE":             return this.onLibraryDelete(userId, msg);

        default:
          return this.reject(userId, payload, `unknown intent ${kind}`);
      }
    } catch (err) {
      this.reject(userId, payload, (err as Error).message);
    }
  }

  // -------------------------------------------------------------------
  // Order-book intent handlers
  // -------------------------------------------------------------------

  private onPlace(userId: UserId, msg: Record<string, unknown>, ioc: boolean): void {
    if (this.state.status !== "playing") return this.reject(userId, msg, "market not open");
    if (this.state.seats.indexOf(userId) < 0) return this.reject(userId, msg, "spectators may not trade");
    const contractId = asContractId(String(msg["contractId"] ?? ""));
    const side = String(msg["side"] ?? "") as OrderSide;
    const qty = Number(msg["qty"]);
    const price = Number(msg["price"]);
    if (side !== "buy" && side !== "sell") return this.reject(userId, msg, "side must be buy or sell");
    const book = this.state.books[contractId];
    if (!book) return this.reject(userId, msg, "unknown contract");
    if (!Number.isInteger(qty) || qty <= 0) return this.reject(userId, msg, "invalid qty");
    if (!Number.isInteger(price)) return this.reject(userId, msg, "invalid price");

    const participant: ParticipantId = { kind: "player", userId };
    const result = placeOrder(book, {
      participant, contractId, side, qty, price, ioc,
      ts: this.clock.now(), phase: this.state.phase,
      mintOrderId: () => asOrderId(String(this.state.nextOrderSeq++)),
      mintTradeId: () => asTradeId(String(this.state.nextTradeSeq++)),
    });
    for (const trade of result.trades) {
      this.state.trades.push(trade);
      applyTrade(this.state, trade);
    }
    this.afterTrades(result.trades);
    this.broadcastSnapshot();
  }

  private onCancel(userId: UserId, msg: Record<string, unknown>): void {
    if (this.state.status !== "playing") return this.reject(userId, msg, "market not open");
    const orderId = asOrderId(String(msg["orderId"] ?? ""));
    for (const book of Object.values(this.state.books)) {
      const order = book.ordersById[orderId];
      if (order && order.participant.kind === "player" && order.participant.userId === userId) {
        cancelOrder(book, orderId);
        this.broadcastSnapshot();
        return;
      }
    }
    this.reject(userId, msg, "order not found or not yours");
  }

  // -------------------------------------------------------------------
  // Setup-phase intents (host only)
  // -------------------------------------------------------------------

  private requireSetup(userId: UserId, msg: unknown): boolean {
    if (userId !== this.state.hostUserId) {
      this.reject(userId, msg, "host only");
      return false;
    }
    if (this.state.status !== "setup") {
      this.reject(userId, msg, "not in setup phase");
      return false;
    }
    return true;
  }

  private onSetupAddContract(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const name = String(msg["name"] ?? "");
    const description = String(msg["description"] ?? "");
    const payoffSource = String(msg["payoffSource"] ?? "");
    if (!name) return this.reject(userId, msg, "name required");
    const v = validatePayoffSource(payoffSource);
    if (!v.ok) return this.reject(userId, msg, v.reason ?? "invalid payoff");
    const id = asContractId(`c${this.state.contracts.length + 1}`);
    this.state.contracts.push({ id, name, description, payoffSource, payoffHash: "" });
    this.broadcastSnapshot();
  }

  private onSetupRemoveContract(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const cid = asContractId(String(msg["contractId"] ?? ""));
    const idx = this.state.contracts.findIndex((c) => c.id === cid);
    if (idx < 0) return this.reject(userId, msg, "no such contract");
    this.state.contracts.splice(idx, 1);
    this.broadcastSnapshot();
  }

  private onSetupReplaceContract(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const cid = asContractId(String(msg["contractId"] ?? ""));
    const idx = this.state.contracts.findIndex((c) => c.id === cid);
    if (idx < 0) return this.reject(userId, msg, "no such contract");
    const name = String(msg["name"] ?? this.state.contracts[idx]!.name);
    const description = String(msg["description"] ?? this.state.contracts[idx]!.description);
    const payoffSource = String(msg["payoffSource"] ?? this.state.contracts[idx]!.payoffSource);
    const v = validatePayoffSource(payoffSource);
    if (!v.ok) return this.reject(userId, msg, v.reason ?? "invalid payoff");
    this.state.contracts[idx] = { id: cid, name, description, payoffSource, payoffHash: "" };
    this.broadcastSnapshot();
  }

  private onSetupImportContract(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const source = String(msg["source"] ?? "");
    const refId = String(msg["refId"] ?? "");
    if (source !== "shared") {
      return this.reject(userId, msg, "only 'shared' source supported in v0.1");
    }
    const entry = loadSharedContract(refId);
    if (!entry) return this.reject(userId, msg, `unknown shared contract: ${refId}`);
    const id = asContractId(`c${this.state.contracts.length + 1}`);
    this.state.contracts.push({
      id, name: entry.name, description: entry.description,
      payoffSource: entry.payoffSource, payoffHash: "",
    });
    this.broadcastSnapshot();
  }

  private onSetupSetBotEntities(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const ids = msg["entityIds"];
    if (!Array.isArray(ids)) return this.reject(userId, msg, "entityIds must be an array");
    const entityIds = ids.filter((x): x is string => typeof x === "string");

    // Each entityId must be a valid 2-letter code.
    for (const e of entityIds) {
      if (!isValidCode(e)) return this.reject(userId, msg, `invalid entity id ${e}`);
    }
    // Uniqueness check: case-insensitive within the entity list.
    const seen = new Set<string>();
    for (const e of entityIds) {
      const k = e.toLowerCase();
      if (seen.has(k)) return this.reject(userId, msg, `duplicate entity ${e}`);
      seen.add(k);
    }

    // Drop entities removed from the list; add new ones with strategy=null.
    const currentMap = new Map(this.state.botEntities.map((e) => [e.entityId, e]));
    const newList: BotEntity[] = [];
    for (const id of entityIds) {
      const existing = currentMap.get(id);
      newList.push(existing ?? { entityId: id, strategyId: null });
    }
    this.state.botEntities = newList;

    // Sync code book: remove dropped, add new (entityId IS the code).
    const newKeys = new Set(newList.map((e) => participantKey({ kind: "bot", entityId: e.entityId })));
    for (const key of Object.keys(this.state.codeBook)) {
      if (key.startsWith("b:") && !newKeys.has(key)) delete this.state.codeBook[key];
    }
    for (const e of newList) {
      const key = participantKey({ kind: "bot", entityId: e.entityId });
      if (!this.state.codeBook[key]) this.state.codeBook[key] = e.entityId;
      this.state.displayNames[key] = e.entityId;
    }
    this.broadcastSnapshot();
  }

  private onSetupBindBotStrategy(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const entityId = String(msg["entityId"] ?? "");
    const raw = msg["strategyId"];
    const strategyId = raw === null || raw === undefined ? null : String(raw);
    const idx = this.state.botEntities.findIndex((e) => e.entityId === entityId);
    if (idx < 0) return this.reject(userId, msg, "no such entity");
    this.state.botEntities[idx] = { entityId, strategyId };
    this.broadcastSnapshot();
  }

  private onSetupSetEventMode(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const mode = String(msg["mode"] ?? "") as EventMode;
    if (mode !== "auto" && mode !== "manual") return this.reject(userId, msg, "invalid mode");
    this.state.options = { ...this.state.options, eventMode: mode };
    this.broadcastSnapshot();
  }

  private onSetupSetCode(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const targetKey = String(msg["participantKey"] ?? "");
    const code = String(msg["code"] ?? "");
    const info = this.participantInfoFor(targetKey);
    if (!info) return this.reject(userId, msg, "no such participant");
    const validation = validateCode(
      code, info, this.state.options.enforceCaseByRole, this.state.codeBook,
    );
    if (!validation.ok) return this.reject(userId, msg, validation.reason);
    this.state.codeBook[targetKey] = code;
    this.broadcastSnapshot();
  }

  private onSetupReshuffleCodes(userId: UserId): void {
    if (!this.requireSetup(userId, "SETUP_RESHUFFLE_CODES")) return;
    this.state.codeBook = this.generateInitialCodeBook();
    this.broadcastSnapshot();
  }

  private onSetupSetIdentityReveal(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const mode = String(msg["mode"] ?? "") as IdentityReveal;
    if (mode !== "all" && mode !== "host" && mode !== "listed") {
      return this.reject(userId, msg, "invalid mode");
    }
    const list = Array.isArray(msg["list"])
      ? (msg["list"] as unknown[]).filter((x): x is string => typeof x === "string").map((s) => s as UserId)
      : this.state.options.identityRevealList;
    this.state.options = { ...this.state.options, identityReveal: mode, identityRevealList: list };
    this.broadcastSnapshot();
  }

  // -------------------------------------------------------------------
  // Queue ops (used in both setup and play phases)
  // -------------------------------------------------------------------

  private onQueueAppend(userId: UserId, msg: Record<string, unknown>, setup: boolean): void {
    if (!this.requireQueueOp(userId, msg, setup)) return;
    const event = parseEventEntry(msg["event"]);
    if (!event) return this.reject(userId, msg, "invalid event");
    this.state.eventQueue.push(event);
    this.onQueueChanged();
  }

  private onQueueInsert(userId: UserId, msg: Record<string, unknown>, setup: boolean): void {
    if (!this.requireQueueOp(userId, msg, setup)) return;
    const idx = Number(msg["idx"]);
    const event = parseEventEntry(msg["event"]);
    if (!Number.isInteger(idx) || idx < 0 || idx > this.state.eventQueue.length) {
      return this.reject(userId, msg, "invalid idx");
    }
    if (!event) return this.reject(userId, msg, "invalid event");
    this.state.eventQueue.splice(idx, 0, event);
    this.onQueueChanged();
  }

  private onQueueRemove(userId: UserId, msg: Record<string, unknown>, setup: boolean): void {
    if (!this.requireQueueOp(userId, msg, setup)) return;
    const idx = Number(msg["idx"]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.state.eventQueue.length) {
      return this.reject(userId, msg, "invalid idx");
    }
    this.state.eventQueue.splice(idx, 1);
    this.onQueueChanged();
  }

  private onQueueMove(userId: UserId, msg: Record<string, unknown>, setup: boolean): void {
    if (!this.requireQueueOp(userId, msg, setup)) return;
    const from = Number(msg["from"]);
    const to = Number(msg["to"]);
    const len = this.state.eventQueue.length;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= len || to < 0 || to >= len) {
      return this.reject(userId, msg, "invalid from/to");
    }
    const [item] = this.state.eventQueue.splice(from, 1);
    this.state.eventQueue.splice(to, 0, item!);
    this.onQueueChanged();
  }

  private requireQueueOp(userId: UserId, msg: unknown, setup: boolean): boolean {
    if (userId !== this.state.hostUserId) {
      this.reject(userId, msg, "host only");
      return false;
    }
    const expectedStatus = setup ? "setup" : "playing";
    if (this.state.status !== expectedStatus) {
      this.reject(userId, msg, `requires status ${expectedStatus}`);
      return false;
    }
    return true;
  }

  private onQueueChanged(): void {
    // In auto mode, when a queue op happens during play, the active
    // event timer's target stays the same — but if we'd previously
    // armed an end-of-game timer (queue empty trigger), that needs to
    // be reconsidered.
    if (this.state.status === "playing" && this.state.options.eventMode === "auto") {
      if (this.state.eventQueue.length > 0 && this.endTimer !== null) {
        // Cancel the end-of-game timer; re-arm a normal event timer.
        this.clock.cancel(this.endTimer);
        this.endTimer = null;
        this.state.endGameAt = null;
        this.armNextEventTimer();
      }
    }
    this.broadcastSnapshot();
  }

  // -------------------------------------------------------------------
  // START_TRADING — setup → playing
  // -------------------------------------------------------------------

  private onStartTrading(userId: UserId): void {
    if (!this.requireSetup(userId, "START_TRADING")) return;
    if (this.state.contracts.length === 0) {
      return this.reject(userId, "START_TRADING", "no contracts configured");
    }
    if (this.state.eventQueue.length === 0) {
      return this.reject(userId, "START_TRADING", "event queue empty");
    }
    // All bot entities must have a 2-letter code (already enforced by
    // SETUP_SET_BOT_ENTITIES); double-check.
    for (const e of this.state.botEntities) {
      if (!isValidCode(e.entityId)) {
        return this.reject(userId, "START_TRADING", `bot ${e.entityId} has invalid code`);
      }
    }

    deal(this.state);
    for (const c of this.state.contracts) {
      this.state.books[c.id] = emptyBook(c.id);
    }
    this.state.phase = 0;
    this.state.startedAt = this.clock.now();
    this.state.status = "playing";

    this.hooks.onEnterPlaying?.();
    if (this.state.options.eventMode === "auto") {
      this.armNextEventTimer();
    }
    this.broadcastSnapshot();
  }

  /** Called after trades are appended in either player or bot paths. */
  private afterTrades(trades: readonly Trade[]): void {
    if (trades.length > 0) this.hooks.onTrades?.(trades);
    this.hooks.onMarketChanged?.();
  }

  // -------------------------------------------------------------------
  // Per-user contract library (LIBRARY_*)
  // -------------------------------------------------------------------

  private onLibraryList(userId: UserId): void {
    const send = this.connections.get(userId);
    if (!send) return;
    try {
      const entries = this.library().list(userId);
      send({ type: "LIBRARY_LIST_RESULT", entries });
    } catch (err) {
      this.reject(userId, "LIBRARY_LIST", (err as Error).message);
    }
  }

  private onLibrarySave(userId: UserId, msg: Record<string, unknown>): void {
    const name = String(msg["name"] ?? "").trim();
    const description = String(msg["description"] ?? "");
    const payoffSource = String(msg["payoffSource"] ?? "");
    if (!name) return this.reject(userId, msg, "name required");
    const v = validatePayoffSource(payoffSource);
    if (!v.ok) return this.reject(userId, msg, v.reason ?? "invalid payoff");
    try {
      const entry = this.library().save(userId, { name, description, payoffSource });
      const send = this.connections.get(userId);
      if (send) {
        send({ type: "LIBRARY_SAVE_RESULT", entry });
        send({ type: "LIBRARY_LIST_RESULT", entries: this.library().list(userId) });
      }
    } catch (err) {
      this.reject(userId, msg, (err as Error).message);
    }
  }

  private onLibraryUpdate(userId: UserId, msg: Record<string, unknown>): void {
    const id = Number(msg["id"]);
    if (!Number.isInteger(id) || id <= 0) return this.reject(userId, msg, "invalid id");
    const args: { name?: string; description?: string; payoffSource?: string } = {};
    if (typeof msg["name"] === "string") args.name = msg["name"] as string;
    if (typeof msg["description"] === "string") args.description = msg["description"] as string;
    if (typeof msg["payoffSource"] === "string") {
      const src = msg["payoffSource"] as string;
      const v = validatePayoffSource(src);
      if (!v.ok) return this.reject(userId, msg, v.reason ?? "invalid payoff");
      args.payoffSource = src;
    }
    try {
      const entry = this.library().update(userId, id, args);
      if (!entry) return this.reject(userId, msg, "not found");
      const send = this.connections.get(userId);
      if (send) {
        send({ type: "LIBRARY_UPDATE_RESULT", entry });
        send({ type: "LIBRARY_LIST_RESULT", entries: this.library().list(userId) });
      }
    } catch (err) {
      this.reject(userId, msg, (err as Error).message);
    }
  }

  private onLibraryDelete(userId: UserId, msg: Record<string, unknown>): void {
    const id = Number(msg["id"]);
    if (!Number.isInteger(id) || id <= 0) return this.reject(userId, msg, "invalid id");
    try {
      const ok = this.library().remove(userId, id);
      if (!ok) return this.reject(userId, msg, "not found");
      const send = this.connections.get(userId);
      if (send) {
        send({ type: "LIBRARY_DELETE_RESULT", id });
        send({ type: "LIBRARY_LIST_RESULT", entries: this.library().list(userId) });
      }
    } catch (err) {
      this.reject(userId, msg, (err as Error).message);
    }
  }

  // -------------------------------------------------------------------
  // Auto-mode timer
  // -------------------------------------------------------------------

  private armNextEventTimer(): void {
    if (this.eventTimer !== null) {
      this.clock.cancel(this.eventTimer);
      this.eventTimer = null;
    }
    if (this.endTimer !== null) {
      this.clock.cancel(this.endTimer);
      this.endTimer = null;
    }
    const min = this.state.options.eventIntervalMin;
    const max = this.state.options.eventIntervalMax;
    const sec = randomInt(min, max, this.state.rng);
    const ms = sec * 1000;
    this.state.nextEventAt = this.clock.now() + ms;
    this.state.endGameAt = null;

    if (this.state.eventQueue.length === 0) {
      // Queue's empty: this timer becomes the end-of-game timer.
      this.state.endGameAt = this.state.nextEventAt;
      this.state.nextEventAt = null;
      this.endTimer = this.clock.schedule(ms, () => this.onAutoEndGameTimer());
    } else {
      this.eventTimer = this.clock.schedule(ms, () => this.onAutoEventTimer());
    }
  }

  private onAutoEventTimer(): void {
    this.eventTimer = null;
    this.state.nextEventAt = null;
    if (this.state.status !== "playing") return;
    this.popAndApplyHeadOfQueue();
    if (this.state.status === "playing") {
      this.armNextEventTimer();
    }
  }

  private onAutoEndGameTimer(): void {
    this.endTimer = null;
    this.state.endGameAt = null;
    if (this.state.status !== "playing") return;
    this.settleAndFinish();
  }

  private popAndApplyHeadOfQueue(): void {
    const head = this.state.eventQueue.shift();
    if (!head) return;
    let event: GameEvent;
    if (head.type === "ROTATE_INFORMED") {
      event = rotateInformed(this.state);
    } else {
      try {
        event = revealPublic(this.state, head.slotIndex ?? null);
      } catch {
        // Slot already revealed or out-of-range: silently advance phase.
        this.state.phase++;
        event = { type: "ROTATED" };
      }
    }
    this.hooks.onEvent?.(event);
    this.hooks.onMarketChanged?.();
    this.broadcastSnapshot();
  }

  // -------------------------------------------------------------------
  // Play-phase host intents
  // -------------------------------------------------------------------

  private requirePlayingHost(userId: UserId, msg: unknown): boolean {
    if (userId !== this.state.hostUserId) {
      this.reject(userId, msg, "host only");
      return false;
    }
    if (this.state.status !== "playing") {
      this.reject(userId, msg, "not in playing phase");
      return false;
    }
    return true;
  }

  private onDelayNextEvent(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requirePlayingHost(userId, msg)) return;
    if (this.state.options.eventMode !== "auto") {
      return this.reject(userId, msg, "auto mode only");
    }
    const seconds = Number(msg["seconds"]);
    if (!Number.isFinite(seconds)) return this.reject(userId, msg, "invalid seconds");

    // Cancel current event/end timer; re-arm at (now + max(1s, currentTarget + delta - now)).
    const deltaMs = Math.floor(seconds * 1000);
    const currentTarget = this.state.nextEventAt ?? this.state.endGameAt;
    if (currentTarget === null) return this.reject(userId, msg, "no active timer");
    const newTarget = Math.max(this.clock.now() + 1000, currentTarget + deltaMs);
    const newMs = newTarget - this.clock.now();

    if (this.eventTimer !== null) this.clock.cancel(this.eventTimer);
    if (this.endTimer !== null) this.clock.cancel(this.endTimer);
    this.eventTimer = null;
    this.endTimer = null;

    if (this.state.eventQueue.length === 0) {
      this.state.endGameAt = newTarget;
      this.state.nextEventAt = null;
      this.endTimer = this.clock.schedule(newMs, () => this.onAutoEndGameTimer());
    } else {
      this.state.nextEventAt = newTarget;
      this.state.endGameAt = null;
      this.eventTimer = this.clock.schedule(newMs, () => this.onAutoEventTimer());
    }
    this.broadcastSnapshot();
  }

  private onPreponeNextEvent(userId: UserId): void {
    if (!this.requirePlayingHost(userId, "PREPONE_NEXT_EVENT")) return;
    if (this.state.options.eventMode !== "auto") {
      return this.reject(userId, "PREPONE_NEXT_EVENT", "auto mode only");
    }
    if (this.eventTimer !== null) {
      this.clock.cancel(this.eventTimer);
      this.eventTimer = null;
      this.state.nextEventAt = null;
      this.popAndApplyHeadOfQueue();
      if (this.state.status === "playing") this.armNextEventTimer();
    } else if (this.endTimer !== null) {
      this.clock.cancel(this.endTimer);
      this.endTimer = null;
      this.state.endGameAt = null;
      this.settleAndFinish();
    }
  }

  private onFireNextEvent(userId: UserId): void {
    if (!this.requirePlayingHost(userId, "FIRE_NEXT_EVENT")) return;
    if (this.state.options.eventMode !== "manual") {
      return this.reject(userId, "FIRE_NEXT_EVENT", "manual mode only");
    }
    if (this.state.eventQueue.length === 0) {
      return this.reject(userId, "FIRE_NEXT_EVENT", "queue empty");
    }
    this.popAndApplyHeadOfQueue();
  }

  private onEndGame(userId: UserId): void {
    if (!this.requirePlayingHost(userId, "END_GAME")) return;
    if (this.state.options.eventMode !== "manual") {
      return this.reject(userId, "END_GAME", "manual mode only");
    }
    if (this.state.eventQueue.length > 0) {
      return this.reject(userId, "END_GAME", "queue must be empty");
    }
    if (this.graceTimer !== null) {
      this.clock.cancel(this.graceTimer);
      this.graceTimer = null;
      this.state.graceTimerEndsAt = null;
    }
    this.settleAndFinish();
  }

  private onStartGraceTimer(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requirePlayingHost(userId, msg)) return;
    if (this.state.options.eventMode !== "manual") {
      return this.reject(userId, msg, "manual mode only");
    }
    const seconds = Number(msg["seconds"]);
    if (!Number.isInteger(seconds) || seconds <= 0) {
      return this.reject(userId, msg, "invalid seconds");
    }
    if (this.graceTimer !== null) this.clock.cancel(this.graceTimer);
    const ms = seconds * 1000;
    this.state.graceTimerEndsAt = this.clock.now() + ms;
    this.graceTimer = this.clock.schedule(ms, () => {
      this.graceTimer = null;
      this.state.graceTimerEndsAt = null;
      if (this.state.status === "playing") this.settleAndFinish();
    });
    this.broadcastSnapshot();
  }

  private onCancelGraceTimer(userId: UserId): void {
    if (!this.requirePlayingHost(userId, "CANCEL_GRACE_TIMER")) return;
    if (this.graceTimer !== null) {
      this.clock.cancel(this.graceTimer);
      this.graceTimer = null;
      this.state.graceTimerEndsAt = null;
      this.broadcastSnapshot();
    }
  }

  // -------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------

  private settleAndFinish(): void {
    revealAllRemaining(this.state);
    const cards = finalCardTuple(this.state);
    const { settlements } = settleAll(this.state.contracts, cards, this.state.options.informedSeats);
    this.state.settlements = settlements as Record<ContractId, number>;

    // Compute final PnL for every participant in the code book.
    const finalPnl: Record<string, number> = {};
    for (const key of Object.keys(this.state.codeBook)) {
      finalPnl[key] = settledPnl(
        this.state,
        keyToParticipant(key),
        settlements as Record<ContractId, number>,
      );
    }
    this.state.finalPnl = finalPnl;
    this.state.status = "finished";

    // Cancel anything still scheduled.
    if (this.eventTimer) { this.clock.cancel(this.eventTimer); this.eventTimer = null; }
    if (this.endTimer)   { this.clock.cancel(this.endTimer);   this.endTimer = null; }
    if (this.graceTimer) { this.clock.cancel(this.graceTimer); this.graceTimer = null; }
    this.state.nextEventAt = null;
    this.state.endGameAt = null;
    this.state.graceTimerEndsAt = null;

    this.hooks.onGameOver?.();
    this.broadcastSnapshot();
  }

  // -------------------------------------------------------------------
  // Bot-side intent submission (used by the future orchestrator runtime)
  // -------------------------------------------------------------------

  /** Submit an intent on behalf of a bot entity. Same validation as a
   *  player intent except the participant is `{ kind: "bot", entityId }`.
   *
   *  Returns either `{ok:false}` or `{ok:true, value:...}` with a value
   *  shape that depends on the intent kind. The orchestrator translates
   *  these into the `BotContext` action API return shapes. */
  submitBotIntent(entityId: string, intent: Record<string, unknown>): BotIntentResult {
    if (this.state.status !== "playing") return { ok: false, reason: "market not open" };
    const entity = this.state.botEntities.find((e) => e.entityId === entityId);
    if (!entity) return { ok: false, reason: "unknown bot entity" };
    const kind = String(intent["type"] ?? "");
    if (kind === "PLACE_LIMIT" || kind === "PLACE_IOC") {
      const contractId = asContractId(String(intent["contractId"] ?? ""));
      const side = String(intent["side"] ?? "") as OrderSide;
      const qty = Number(intent["qty"]);
      const price = Number(intent["price"]);
      if (side !== "buy" && side !== "sell") return { ok: false, reason: "side must be buy or sell" };
      const book = this.state.books[contractId];
      if (!book) return { ok: false, reason: "unknown contract" };
      if (!Number.isInteger(qty) || qty <= 0) return { ok: false, reason: "invalid qty" };
      if (!Number.isInteger(price)) return { ok: false, reason: "invalid price" };
      const r = placeOrder(book, {
        participant: { kind: "bot", entityId }, contractId, side, qty, price,
        ioc: kind === "PLACE_IOC", ts: this.clock.now(), phase: this.state.phase,
        mintOrderId: () => asOrderId(String(this.state.nextOrderSeq++)),
        mintTradeId: () => asTradeId(String(this.state.nextTradeSeq++)),
      });
      for (const t of r.trades) {
        this.state.trades.push(t);
        applyTrade(this.state, t);
      }
      this.afterTrades(r.trades);
      this.broadcastSnapshot();
      return {
        ok: true,
        value: { orderId: r.residentOrderId, fills: r.trades.slice() },
      };
    }
    if (kind === "CANCEL_ORDER") {
      const orderId = asOrderId(String(intent["orderId"] ?? ""));
      for (const book of Object.values(this.state.books)) {
        const order = book.ordersById[orderId];
        if (order && order.participant.kind === "bot" && order.participant.entityId === entityId) {
          cancelOrder(book, orderId);
          this.broadcastSnapshot();
          return { ok: true, value: { cancelled: 1 } };
        }
      }
      return { ok: false, reason: "order not found or not yours" };
    }
    return { ok: false, reason: `bots cannot submit ${kind}` };
  }

  /** Register observer hooks. Used by the bot orchestrator. */
  setHooks(hooks: SessionHooks): void {
    this.hooks = hooks;
  }

  /** Cancel every resting order owned by `entityId`. */
  cancelAllForBot(entityId: string): { ok: true; value: { cancelled: number } } {
    let cancelled = 0;
    for (const book of Object.values(this.state.books)) {
      const ids = Object.values(book.ordersById)
        .filter((o) => o.participant.kind === "bot" && o.participant.entityId === entityId)
        .map((o) => o.id);
      for (const id of ids) {
        if (cancelOrder(book, id)) cancelled++;
      }
    }
    if (cancelled > 0) this.broadcastSnapshot();
    return { ok: true, value: { cancelled } };
  }

  // -------------------------------------------------------------------
  // Persistence + describe
  // -------------------------------------------------------------------

  serialize(): MockerySave {
    return {
      version: 1,
      options: this.state.options,
      hostUserId: this.state.hostUserId,
      seats: this.state.seats.slice(),
      seatDisplayNames: this.seatDisplayNames.slice(),
      status: this.inPlatformLobby ? "lobby" : this.state.status,
    };
  }

  describe(): SessionDescription {
    return {
      status: this.inPlatformLobby
        ? "lobby"
        : this.state.status === "finished"
          ? "finished"
          : "playing",
      playerCount: this.state.seats.filter((s) => s !== null).length,
      maxPlayers: this.state.seats.length,
      spectatorCount: this.spectators.size,
      lastActivityAt: this.lastActivityAt,
      playableSeatIndices: this.state.seats.map((_, i) => i),
    };
  }

  // -------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------

  private generateInitialCodeBook() {
    const ps: ParticipantInfo[] = [];
    for (let i = 0; i < this.state.seats.length; i++) {
      const u = this.state.seats[i];
      if (!u) continue;
      ps.push({
        id: { kind: "player", userId: u },
        displayName:
          this.state.displayNames[participantKey({ kind: "player", userId: u })] ??
          this.seatDisplayNames[i] ??
          `Seat ${i + 1}`,
        informed: i < this.state.options.informedSeats,
      });
    }
    for (const e of this.state.botEntities) {
      ps.push({
        id: { kind: "bot", entityId: e.entityId },
        displayName: e.entityId,
        informed: false,
      });
    }
    return generateCodeBook(ps, {
      mode: this.state.options.codeMode,
      enforceCaseByRole: this.state.options.enforceCaseByRole,
      rng: this.state.rng,
    });
  }

  private participantInfoFor(key: string): ParticipantInfo | null {
    if (key.startsWith("p:")) {
      const userId = key.slice(2) as UserId;
      const seatIndex = this.state.seats.indexOf(userId);
      if (seatIndex < 0) return null;
      return {
        id: { kind: "player", userId },
        displayName: this.state.displayNames[key] ?? `Seat ${seatIndex + 1}`,
        informed: seatIndex < this.state.options.informedSeats,
      };
    }
    if (key.startsWith("b:")) {
      const entityId = key.slice(2);
      if (!this.state.botEntities.some((e) => e.entityId === entityId)) return null;
      return {
        id: { kind: "bot", entityId },
        displayName: entityId,
        informed: false,
      };
    }
    return null;
  }

  private reject(userId: UserId, intent: unknown, reason: string): void {
    const send = this.connections.get(userId);
    if (send) send({ type: "INTENT_REJECTED", intent, reason });
  }

  private sendSnapshotTo(userId: UserId): void {
    const send = this.connections.get(userId);
    if (!send) return;
    const snap = this.projectFor(userId);
    send({ type: "STATE_SNAPSHOT", snap });
  }

  private broadcastSnapshot(): void {
    for (const userId of this.connections.keys()) {
      this.sendSnapshotTo(userId);
    }
  }

  /** Public for tests and the bot orchestrator. */
  projectFor(userId: UserId): ProjectedSnapshot {
    const platformStatus = this.inPlatformLobby
      ? "lobby"
      : this.state.status === "finished"
        ? "finished"
        : "playing";
    const msUntilNextEvent =
      this.state.nextEventAt !== null ? Math.max(0, this.state.nextEventAt - this.clock.now()) : null;
    const graceMs =
      this.state.graceTimerEndsAt !== null ? Math.max(0, this.state.graceTimerEndsAt - this.clock.now()) : null;
    return project({
      state: this.state,
      viewerUserId: userId,
      platformStatus,
      msUntilNextEvent,
      graceTimerMs: graceMs,
    });
  }

  /** Read-only access to engine state. Used by the bot orchestrator
   *  to build per-bot snapshots, and by tests for assertions.
   *  Callers MUST NOT mutate. */
  getEngineState(): GameState {
    return this.state;
  }

  /** @deprecated alias kept for older tests. */
  getStateForTesting(): GameState {
    return this.state;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function parseEventEntry(raw: unknown): EventQueueEntry | null {
  const o = asObject(raw);
  if (!o) return null;
  const type = String(o["type"] ?? "");
  if (type === "ROTATE_INFORMED") return { type };
  if (type === "REVEAL_PUBLIC") {
    const slot = o["slotIndex"];
    if (slot === null || slot === undefined) return { type, slotIndex: null };
    if (typeof slot === "number" && Number.isInteger(slot) && slot >= 0) {
      return { type, slotIndex: slot };
    }
    return null;
  }
  return null;
}

function keyToParticipant(key: string): ParticipantId {
  if (key.startsWith("p:")) return { kind: "player", userId: key.slice(2) as UserId };
  return { kind: "bot", entityId: key.slice(2) };
}

// ---------------------------------------------------------------------------
// Shared contract library loader
// ---------------------------------------------------------------------------

interface SharedContractEntry {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly payoffSource: string;
}

let cachedSharedContracts: SharedContractEntry[] | null = null;

function loadSharedContract(refId: string): SharedContractEntry | null {
  if (cachedSharedContracts === null) {
    try {
      // Lazily; reads at most once per process.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require("node:fs") as typeof import("node:fs");
      const data = JSON.parse(fs.readFileSync(SHARED_CONTRACTS_PATH, "utf8"));
      cachedSharedContracts = (data?.entries ?? []) as SharedContractEntry[];
    } catch {
      cachedSharedContracts = [];
    }
  }
  return cachedSharedContracts.find((e) => e.id === refId) ?? null;
}

// Suppress "imported but unused" if Trade is referenced only by type alias.
void undefined as unknown as Trade;
