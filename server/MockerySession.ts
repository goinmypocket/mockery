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
  type ActionActor,
  type ActionLogEntry,
  type BotEntity,
  type BotGroup,
  type BotStateSnapshot,
  type CodeMode,
  type ContractDef,
  type EventMode,
  type EventQueueEntry,
  type IdentityReveal,
  type Order,
  type OrderBook,
  type OrderSide,
  type ParticipantId,
  type PriceLevel,
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
import { getRngState, randomInt, rngFromState } from "../engine/rng";
import { readFileSync } from "node:fs";
import { realClock, type SessionClock, type TimerHandle } from "./clock";
import { getLibrary, type ContractLibrary } from "./db/library";
import { MAX_SEAT_COUNT, readResolved } from "./options";

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
  /** Optional bot-state provider, invoked synchronously by the session
   *  when it writes an action-log entry so each entry can carry a
   *  snapshot of every live bot's params + scratchpad. The
   *  orchestrator installs this; tests or alternative hosts can omit
   *  it (entries will have an empty `botStates` array). */
  botStateProvider?(): readonly BotStateSnapshot[];
}

const SHARED_CONTRACTS_PATH = new URL("../config/shared-contracts.json", import.meta.url);

// ---------------------------------------------------------------------------
// Save / load
// ---------------------------------------------------------------------------

export interface MockerySave {
  readonly version: 2;
  readonly options: ResolvedOptions;
  readonly hostUserId: UserId;
  readonly seats: ReadonlyArray<UserId | null>;
  readonly seatDisplayNames: ReadonlyArray<string | null>;
  readonly status: "lobby" | "setup" | "playing" | "finished";

  // Full engine snapshot (only meaningful when status !== "lobby"):
  readonly rngState?: readonly number[];
  readonly informedCards?: readonly number[];
  /** Parallel to `informedCards`. Optional for back-compat with v2
   *  saves written before card-origin tracking landed; on hydrate we
   *  default to the identity permutation (i.e. assume no rotations
   *  have happened, which is wrong for in-flight games but the only
   *  reasonable inference without further state). */
  readonly informedCardOrigin?: readonly number[];
  /** Per-seat list of origin indices the seat's player has held at
   *  some point. Optional for back-compat; on hydrate we default to
   *  each informed seat having seen its currently-held origin (which
   *  preserves the immediately-visible card but loses any earlier
   *  cards that have already rotated away — the only inference
   *  available without the full history). */
  readonly seenInformedCardOrigins?: ReadonlyArray<readonly number[]>;
  readonly publicCards?: readonly number[];
  readonly publicRevealed?: readonly boolean[];
  readonly phase?: number;
  readonly startedAt?: number;
  readonly nextEventAt?: number | null;
  readonly graceTimerEndsAt?: number | null;
  readonly endGameAt?: number | null;
  readonly contracts?: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly payoffSource: string;
    readonly payoffHash: string;
  }>;
  readonly eventQueue?: readonly EventQueueEntry[];
  readonly botEntities?: ReadonlyArray<{
    readonly entityId: string;
    readonly strategyId: string | null;
    readonly params?: Readonly<Record<string, unknown>> | null;
    readonly config?: Readonly<Record<string, unknown>> | null;
  }>;
  readonly botGroups?: readonly BotGroup[];
  readonly displayNames?: Readonly<Record<string, string>>;
  readonly codeBook?: Readonly<Record<string, string>>;
  readonly books?: Readonly<Record<string, SavedBook>>;
  readonly positions?: Readonly<Record<string, Record<string, number>>>;
  readonly cash?: Readonly<Record<string, number>>;
  readonly trades?: readonly Trade[];
  readonly nextOrderSeq?: number;
  readonly nextTradeSeq?: number;
  readonly settlements?: Readonly<Record<string, number>> | null;
  readonly finalPnl?: Readonly<Record<string, number>> | null;
  readonly actionLog?: readonly ActionLogEntry[];
  readonly nextActionSeq?: number;
}

interface SavedBook {
  readonly contractId: string;
  readonly bids: ReadonlyArray<SavedLevel>;
  readonly offers: ReadonlyArray<SavedLevel>;
  readonly lastTradePrice: number | null;
}

interface SavedLevel {
  readonly price: number;
  readonly orders: ReadonlyArray<{
    readonly id: string;
    readonly participant: ParticipantId;
    readonly contractId: string;
    readonly side: OrderSide;
    readonly price: number;
    readonly qty: number;
    readonly enteredAt: number;
  }>;
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
  s.hydrate(blob);
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
    // Always allocate MAX_SEAT_COUNT slots so the platform's lobby UI
    // (which reads `def.maxPlayers`) and our seat array agree on
    // bounds. Only the first `informedSeats + uninformedSeats` need
    // to be filled; the rest stay null and are validated empty at
    // START_TRADING.
    this.state = createInitialState({
      options: args.options,
      hostUserId: args.hostUserId,
      seats: new Array<UserId | null>(MAX_SEAT_COUNT).fill(null),
      now: this.clock.now(),
    });
    this.seatDisplayNames = new Array<string | null>(MAX_SEAT_COUNT).fill(null);
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
    const required = this.state.options.informedSeats + this.state.options.uninformedSeats;
    if (seatIndex < 0 || seatIndex >= required) {
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
   *  display names. The host configures the rest in setup.
   *
   *  Headcount rule: exactly `informedSeats + uninformedSeats` players
   *  must be claimed, and they must occupy the first N seat indices.
   *  Trailing slots stay null (the platform's lobby may show extra
   *  empty rows that simply aren't used). */
  startGame(callerUserId: UserId): Result {
    if (callerUserId !== this.state.hostUserId) {
      return { ok: false, reason: "only the host may start" };
    }
    if (!this.inPlatformLobby) return { ok: false, reason: "already started" };
    const required = this.state.options.informedSeats + this.state.options.uninformedSeats;
    for (let i = 0; i < required; i++) {
      if (this.state.seats[i] === null) {
        return { ok: false, reason: `seat ${i + 1} must be filled (${required} players needed)` };
      }
    }
    for (let i = required; i < this.state.seats.length; i++) {
      if (this.state.seats[i] !== null) {
        return { ok: false, reason: `seat ${i + 1} is past the player count (${required})` };
      }
    }

    // Capture display names into the engine's per-participant map.
    for (let i = 0; i < required; i++) {
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
        // Snapshot refresh — any phase, any participant. Lazy-mounted
        // UIs send this when they subscribe, since the snapshot the
        // session broadcast at attach time may have been dropped by
        // the client before the subscription was wired up.
        case "REQUEST_SNAPSHOT": return this.sendSnapshotTo(userId);

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
        case "SETUP_SET_BOT_CONFIG":       return this.onSetupSetBotConfig(userId, msg);
        case "SETUP_SET_BOT_GROUP":        return this.onSetupSetBotGroup(userId, msg);
        case "SETUP_REMOVE_BOT_GROUP":     return this.onSetupRemoveBotGroup(userId, msg);
        case "SETUP_SET_EVENT_MODE":       return this.onSetupSetEventMode(userId, msg);
        case "SETUP_SET_GAME_OPTIONS":     return this.onSetupSetGameOptions(userId, msg);
        case "SETUP_SET_CODE":             return this.onSetupSetCode(userId, msg);
        case "SETUP_RESHUFFLE_CODES":      return this.onSetupReshuffleCodes(userId);
        case "SETUP_SWAP_SEATS":           return this.onSetupSwapSeats(userId, msg);
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
    this.logAction(
      { kind: "player", userId },
      ioc ? "PLACE_IOC" : "PLACE_LIMIT",
      { contractId, side, qty, price },
      {
        ok: true,
        value: {
          orderId: result.residentOrderId,
          fillCount: result.trades.length,
          fillQty: result.trades.reduce((s, t) => s + t.qty, 0),
        },
      },
    );
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
        this.logAction(
          { kind: "player", userId },
          "CANCEL_ORDER",
          { orderId, contractId: order.contractId },
          { ok: true },
        );
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
    this.logHostSuccess(userId, "SETUP_ADD_CONTRACT", { id, name });
    this.broadcastSnapshot();
  }

  private onSetupRemoveContract(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const cid = asContractId(String(msg["contractId"] ?? ""));
    const idx = this.state.contracts.findIndex((c) => c.id === cid);
    if (idx < 0) return this.reject(userId, msg, "no such contract");
    this.state.contracts.splice(idx, 1);
    this.logHostSuccess(userId, "SETUP_REMOVE_CONTRACT", { contractId: cid });
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
    this.logHostSuccess(userId, "SETUP_REPLACE_CONTRACT", { contractId: cid, name });
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
    this.logHostSuccess(userId, "SETUP_IMPORT_CONTRACT", { id, refId });
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
    this.logHostSuccess(userId, "SETUP_SET_BOT_ENTITIES", { entityIds });
    this.broadcastSnapshot();
  }

  private onSetupBindBotStrategy(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const entityId = String(msg["entityId"] ?? "");
    const raw = msg["strategyId"];
    const strategyId = raw === null || raw === undefined ? null : String(raw);
    const idx = this.state.botEntities.findIndex((e) => e.entityId === entityId);
    if (idx < 0) return this.reject(userId, msg, "no such entity");
    // Optional per-instance params bag. We don't validate against
    // the strategy's schema here — that happens at instantiation in
    // the orchestrator, which has the strategy table in hand. The
    // session just stores it verbatim so the save round-trips.
    const rawParams = msg["params"];
    const params: Readonly<Record<string, unknown>> | null =
      rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
        ? { ...(rawParams as Record<string, unknown>) }
        : null;
    this.state.botEntities[idx] = { entityId, strategyId, params };
    this.logHostSuccess(userId, "SETUP_BIND_BOT_STRATEGY", { entityId, strategyId, params });
    this.broadcastSnapshot();
  }

  private onSetupSetBotConfig(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const entityId = String(msg["entityId"] ?? "");
    const idx = this.state.botEntities.findIndex((e) => e.entityId === entityId);
    if (idx < 0) return this.reject(userId, msg, "no such entity");
    const raw = msg["config"];
    const config: Readonly<Record<string, unknown>> | null =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? { ...(raw as Record<string, unknown>) }
        : null;
    this.state.botEntities[idx] = { ...this.state.botEntities[idx]!, config };
    this.logHostSuccess(userId, "SETUP_SET_BOT_CONFIG", { entityId });
    this.broadcastSnapshot();
  }

  private onSetupSetBotGroup(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const groupId = String(msg["groupId"] ?? "");
    if (!groupId) return this.reject(userId, msg, "groupId required");
    const entityIdsRaw = msg["entityIds"];
    if (!Array.isArray(entityIdsRaw) || entityIdsRaw.length === 0) {
      return this.reject(userId, msg, "entityIds must be a non-empty array");
    }
    const entityIds = entityIdsRaw.filter((x): x is string => typeof x === "string");
    if (entityIds.length !== entityIdsRaw.length) {
      return this.reject(userId, msg, "entityIds must all be strings");
    }
    // Every entityId must already be a registered bot entity.
    const known = new Set(this.state.botEntities.map((e) => e.entityId));
    for (const eid of entityIds) {
      if (!known.has(eid)) return this.reject(userId, msg, `unknown entityId ${eid}`);
    }
    const rawStrategyId = msg["strategyId"];
    const strategyId =
      rawStrategyId === undefined || rawStrategyId === null ? null : String(rawStrategyId);
    const rawConfig = msg["config"];
    const config: Readonly<Record<string, unknown>> | null =
      rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
        ? { ...(rawConfig as Record<string, unknown>) }
        : null;
    if (!strategyId && !config) return this.reject(userId, msg, "strategyId or config required");
    if (strategyId && config) return this.reject(userId, msg, "specify only one of strategyId / config");
    const rawParams = msg["params"];
    const params: Readonly<Record<string, unknown>> | null =
      rawParams && typeof rawParams === "object" && !Array.isArray(rawParams)
        ? { ...(rawParams as Record<string, unknown>) }
        : null;
    const seed = msg["seed"];
    const group: BotGroup = {
      groupId, entityIds, strategyId, params, config,
      ...(typeof seed === "number" ? { seed } : {}),
    };
    const idx = this.state.botGroups.findIndex((g) => g.groupId === groupId);
    if (idx >= 0) this.state.botGroups[idx] = group;
    else this.state.botGroups.push(group);
    this.logHostSuccess(userId, "SETUP_SET_BOT_GROUP", { groupId, entityIds });
    this.broadcastSnapshot();
  }

  private onSetupRemoveBotGroup(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const groupId = String(msg["groupId"] ?? "");
    const idx = this.state.botGroups.findIndex((g) => g.groupId === groupId);
    if (idx < 0) return this.reject(userId, msg, "no such group");
    this.state.botGroups.splice(idx, 1);
    this.logHostSuccess(userId, "SETUP_REMOVE_BOT_GROUP", { groupId });
    this.broadcastSnapshot();
  }

  private onSetupSetEventMode(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const mode = String(msg["mode"] ?? "") as EventMode;
    if (mode !== "auto" && mode !== "manual") return this.reject(userId, msg, "invalid mode");
    this.state.options = { ...this.state.options, eventMode: mode };
    this.logHostSuccess(userId, "SETUP_SET_EVENT_MODE", { mode });
    this.broadcastSnapshot();
  }

  /** Bulk update of every host-editable option that doesn't change seat
   *  count (those stay at create time). Each field is optional; only
   *  the keys present in `msg` are touched. Validation mirrors
   *  `normalizeMockeryOptions`'s cross-field checks. */
  private onSetupSetGameOptions(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const cur = this.state.options;
    const next = { ...cur };

    if ("publicSlots" in msg) {
      const v = Number(msg["publicSlots"]);
      if (!Number.isInteger(v) || v < 0) return this.reject(userId, msg, "invalid publicSlots");
      next.publicSlots = v;
    }
    if ("copiesPerValue" in msg) {
      const v = Number(msg["copiesPerValue"]);
      if (!Number.isInteger(v) || v <= 0) return this.reject(userId, msg, "invalid copiesPerValue");
      next.copiesPerValue = v;
    }
    if ("cardValuesCsv" in msg) {
      const raw = String(msg["cardValuesCsv"] ?? "");
      const out = raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0).map(Number);
      if (out.length === 0 || out.some((n) => !Number.isFinite(n))) {
        return this.reject(userId, msg, "invalid cardValuesCsv");
      }
      const seen = new Set<number>();
      for (const v of out) {
        if (seen.has(v)) return this.reject(userId, msg, `duplicate card value ${v}`);
        seen.add(v);
      }
      next.cardValues = out;
    }
    if ("eventIntervalMin" in msg) {
      const v = Number(msg["eventIntervalMin"]);
      if (!Number.isInteger(v) || v <= 0) return this.reject(userId, msg, "invalid eventIntervalMin");
      next.eventIntervalMin = v;
    }
    if ("eventIntervalMax" in msg) {
      const v = Number(msg["eventIntervalMax"]);
      if (!Number.isInteger(v) || v <= 0) return this.reject(userId, msg, "invalid eventIntervalMax");
      next.eventIntervalMax = v;
    }
    if ("endGameGraceSec" in msg) {
      const v = Number(msg["endGameGraceSec"]);
      if (!Number.isInteger(v) || v < 0) return this.reject(userId, msg, "invalid endGameGraceSec");
      next.endGameGraceSec = v;
    }
    if ("codeMode" in msg) {
      const v = String(msg["codeMode"] ?? "") as CodeMode;
      if (v !== "alpha" && v !== "random") return this.reject(userId, msg, "invalid codeMode");
      next.codeMode = v;
    }
    if ("enforceCaseByRole" in msg) {
      next.enforceCaseByRole = !!msg["enforceCaseByRole"];
    }

    if (next.eventIntervalMin > next.eventIntervalMax) {
      return this.reject(userId, msg, "eventIntervalMin must be <= eventIntervalMax");
    }
    const deckSize = next.cardValues.length * next.copiesPerValue;
    const cardsInPlay = next.informedSeats + next.publicSlots;
    if (cardsInPlay > deckSize) {
      return this.reject(userId, msg, `cardsInPlay (${cardsInPlay}) exceeds deckSize (${deckSize})`);
    }

    const codeRulesChanged =
      next.codeMode !== cur.codeMode || next.enforceCaseByRole !== cur.enforceCaseByRole;
    this.state.options = next;
    if (codeRulesChanged) {
      this.state.codeBook = this.generateInitialCodeBook();
    }
    this.logHostSuccess(userId, "SETUP_SET_GAME_OPTIONS", { ...msg });
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
    this.logHostSuccess(userId, "SETUP_SET_CODE", { participantKey: targetKey, code });
    this.broadcastSnapshot();
  }

  private onSetupReshuffleCodes(userId: UserId): void {
    if (!this.requireSetup(userId, "SETUP_RESHUFFLE_CODES")) return;
    this.state.codeBook = this.generateInitialCodeBook();
    this.logHostSuccess(userId, "SETUP_RESHUFFLE_CODES");
    this.broadcastSnapshot();
  }

  /** Swap two seats in the seat array (and their display names). The
   *  codeBook is keyed by participantKey, not seat index, so each
   *  player's code follows them — only their *role* changes when the
   *  swap crosses the informed/uninformed boundary.
   *
   *  Setup-only: in playing/finished phases the seat order is frozen
   *  (rotation already used the seat indices to deal cards). */
  private onSetupSwapSeats(userId: UserId, msg: Record<string, unknown>): void {
    if (!this.requireSetup(userId, msg)) return;
    const i = Number(msg["i"]);
    const j = Number(msg["j"]);
    const required = this.state.options.informedSeats + this.state.options.uninformedSeats;
    if (!Number.isInteger(i) || !Number.isInteger(j)) {
      return this.reject(userId, msg, "i and j must be integer seat indices");
    }
    if (i === j) return; // no-op
    if (i < 0 || j < 0 || i >= required || j >= required) {
      return this.reject(userId, msg, "seat index out of range");
    }
    const seats = this.state.seats;
    [seats[i], seats[j]] = [seats[j]!, seats[i]!];
    [this.seatDisplayNames[i], this.seatDisplayNames[j]] =
      [this.seatDisplayNames[j]!, this.seatDisplayNames[i]!];
    this.logHostSuccess(userId, "SETUP_SWAP_SEATS", { i, j });
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
    this.logHostSuccess(userId, "SETUP_SET_IDENTITY_REVEAL", { mode, list });
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
    this.logHostSuccess(userId, setup ? "SETUP_QUEUE_APPEND" : "QUEUE_APPEND", { event });
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
    this.logHostSuccess(userId, setup ? "SETUP_QUEUE_INSERT" : "QUEUE_INSERT", { idx, event });
    this.onQueueChanged();
  }

  private onQueueRemove(userId: UserId, msg: Record<string, unknown>, setup: boolean): void {
    if (!this.requireQueueOp(userId, msg, setup)) return;
    const idx = Number(msg["idx"]);
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.state.eventQueue.length) {
      return this.reject(userId, msg, "invalid idx");
    }
    this.state.eventQueue.splice(idx, 1);
    this.logHostSuccess(userId, setup ? "SETUP_QUEUE_REMOVE" : "QUEUE_REMOVE", { idx });
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
    this.logHostSuccess(userId, setup ? "SETUP_QUEUE_MOVE" : "QUEUE_MOVE", { from, to });
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

    this.logHostSuccess(userId, "START_TRADING");
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

  /** Append a row to the play-phase action log, tagging it with the
   *  current phase / timestamp and a snapshot of every live bot's
   *  params + scratchpad (taken via the orchestrator-installed
   *  provider). Called from every play-phase action handler — both
   *  player intents and bot intents — and from the system-event /
   *  end-game paths. */
  /** Sugar for the most common case: a host (player) action that just
   *  succeeded with no extra return value. */
  private logHostSuccess(
    userId: UserId,
    type: string,
    payload: Readonly<Record<string, unknown>> = {},
  ): void {
    this.logAction({ kind: "player", userId }, type, payload, { ok: true });
  }

  private logAction(
    actor: ActionActor,
    type: string,
    payload: Readonly<Record<string, unknown>>,
    outcome: ActionLogEntry["outcome"],
  ): void {
    const botStates = this.hooks.botStateProvider?.() ?? [];
    this.state.actionLog.push({
      seq: this.state.nextActionSeq++,
      ts: this.clock.now(),
      phase: this.state.phase,
      actor,
      type,
      payload,
      outcome,
      botStates,
    });
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
    this.logAction(
      { kind: "system" },
      head.type,
      head.type === "REVEAL_PUBLIC" ? { slotIndex: head.slotIndex ?? null } : {},
      { ok: true, value: event as unknown as Record<string, unknown> },
    );
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
    this.logHostSuccess(userId, "DELAY_NEXT_EVENT", { seconds, newTarget });
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
      this.logHostSuccess(userId, "PREPONE_NEXT_EVENT");
      this.popAndApplyHeadOfQueue();
      if (this.state.status === "playing") this.armNextEventTimer();
    } else if (this.endTimer !== null) {
      this.clock.cancel(this.endTimer);
      this.endTimer = null;
      this.state.endGameAt = null;
      this.logHostSuccess(userId, "PREPONE_NEXT_EVENT");
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
    this.logHostSuccess(userId, "FIRE_NEXT_EVENT");
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
    this.logHostSuccess(userId, "END_GAME");
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
    this.logHostSuccess(userId, "START_GRACE_TIMER", { seconds });
    this.broadcastSnapshot();
  }

  private onCancelGraceTimer(userId: UserId): void {
    if (!this.requirePlayingHost(userId, "CANCEL_GRACE_TIMER")) return;
    if (this.graceTimer !== null) {
      this.clock.cancel(this.graceTimer);
      this.graceTimer = null;
      this.state.graceTimerEndsAt = null;
      this.logHostSuccess(userId, "CANCEL_GRACE_TIMER");
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

    this.logAction(
      { kind: "system" },
      "END_GAME",
      {},
      { ok: true, value: { settlements: { ...settlements }, finalPnl: { ...finalPnl } } },
    );

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
    const actor: ActionActor = { kind: "bot", entityId };
    const fail = (type: string, payload: Record<string, unknown>, reason: string): BotIntentResult => {
      this.logAction(actor, type, payload, { ok: false, reason });
      return { ok: false, reason };
    };

    if (this.state.status !== "playing") return fail("UNKNOWN", { intent }, "market not open");
    const entity = this.state.botEntities.find((e) => e.entityId === entityId);
    if (!entity) return fail("UNKNOWN", { intent }, "unknown bot entity");
    const kind = String(intent["type"] ?? "");
    if (kind === "PLACE_LIMIT" || kind === "PLACE_IOC") {
      const contractId = asContractId(String(intent["contractId"] ?? ""));
      const side = String(intent["side"] ?? "") as OrderSide;
      const qty = Number(intent["qty"]);
      const price = Number(intent["price"]);
      const payload = { contractId, side, qty, price };
      if (side !== "buy" && side !== "sell") return fail(kind, payload, "side must be buy or sell");
      const book = this.state.books[contractId];
      if (!book) return fail(kind, payload, "unknown contract");
      if (!Number.isInteger(qty) || qty <= 0) return fail(kind, payload, "invalid qty");
      if (!Number.isInteger(price)) return fail(kind, payload, "invalid price");
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
      this.logAction(actor, kind, payload, {
        ok: true,
        value: {
          orderId: r.residentOrderId,
          fillCount: r.trades.length,
          fillQty: r.trades.reduce((s, t) => s + t.qty, 0),
        },
      });
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
          this.logAction(
            actor,
            "CANCEL_ORDER",
            { orderId, contractId: order.contractId },
            { ok: true },
          );
          this.broadcastSnapshot();
          return { ok: true, value: { cancelled: 1 } };
        }
      }
      return fail("CANCEL_ORDER", { orderId }, "order not found or not yours");
    }
    return fail(kind || "UNKNOWN", { intent }, `bots cannot submit ${kind}`);
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
    this.logAction(
      { kind: "bot", entityId },
      "CANCEL_ALL",
      {},
      { ok: true, value: { cancelled } },
    );
    if (cancelled > 0) this.broadcastSnapshot();
    return { ok: true, value: { cancelled } };
  }

  // -------------------------------------------------------------------
  // Persistence + describe
  // -------------------------------------------------------------------

  serialize(): MockerySave {
    const status: MockerySave["status"] = this.inPlatformLobby ? "lobby" : this.state.status;
    if (this.inPlatformLobby) {
      return {
        version: 2,
        options: this.state.options,
        hostUserId: this.state.hostUserId,
        seats: this.state.seats.slice(),
        seatDisplayNames: this.seatDisplayNames.slice(),
        status,
      };
    }

    const books: Record<string, SavedBook> = {};
    for (const [cid, b] of Object.entries(this.state.books)) {
      books[cid] = saveBook(b);
    }

    const positions: Record<string, Record<string, number>> = {};
    for (const [k, m] of Object.entries(this.state.positions)) {
      positions[k] = { ...m } as Record<string, number>;
    }

    return {
      version: 2,
      options: this.state.options,
      hostUserId: this.state.hostUserId,
      seats: this.state.seats.slice(),
      seatDisplayNames: this.seatDisplayNames.slice(),
      status,
      rngState: getRngState(this.state.rng),
      informedCards: this.state.informedCards.slice(),
      informedCardOrigin: this.state.informedCardOrigin.slice(),
      seenInformedCardOrigins: this.state.seenInformedCardOrigins.map((arr) => arr.slice()),
      publicCards: this.state.publicCards.slice(),
      publicRevealed: this.state.publicRevealed.slice(),
      phase: this.state.phase,
      startedAt: this.state.startedAt,
      nextEventAt: this.state.nextEventAt,
      graceTimerEndsAt: this.state.graceTimerEndsAt,
      endGameAt: this.state.endGameAt,
      contracts: this.state.contracts.map((c) => ({
        id: c.id as string,
        name: c.name,
        description: c.description,
        payoffSource: c.payoffSource,
        payoffHash: c.payoffHash,
      })),
      eventQueue: this.state.eventQueue.map((e) => ({ ...e })),
      botEntities: this.state.botEntities.map((b) => ({ ...b })),
      botGroups: this.state.botGroups.map((g) => ({ ...g })),
      displayNames: { ...this.state.displayNames },
      codeBook: { ...this.state.codeBook },
      books,
      positions,
      cash: { ...this.state.cash },
      trades: this.state.trades.map((t) => ({ ...t })),
      nextOrderSeq: this.state.nextOrderSeq,
      nextTradeSeq: this.state.nextTradeSeq,
      settlements: this.state.settlements ? { ...this.state.settlements } as Record<string, number> : null,
      finalPnl: this.state.finalPnl ? { ...this.state.finalPnl } : null,
      actionLog: this.state.actionLog.slice(),
      nextActionSeq: this.state.nextActionSeq,
    };
  }

  /** Restore session state from a previously serialized blob. Called by
   *  `loadFromOpts` after construction; tests can also call this directly
   *  to round-trip a save against a custom clock. */
  hydrate(blob: MockerySave): void {
    // Lobby blobs carry only seats + display names.
    for (let i = 0; i < this.state.seats.length; i++) {
      this.state.seats[i] = blob.seats[i] ?? null;
      this.seatDisplayNames[i] = blob.seatDisplayNames[i] ?? null;
    }
    if (blob.status === "lobby") {
      this.inPlatformLobby = true;
      this.lastActivityAt = this.clock.now();
      return;
    }

    this.inPlatformLobby = false;
    if (blob.rngState) this.state.rng = rngFromState([...blob.rngState]);
    this.state.status = blob.status;
    this.state.informedCards = blob.informedCards ? [...blob.informedCards] : [];
    this.state.informedCardOrigin = blob.informedCardOrigin
      ? [...blob.informedCardOrigin]
      : this.state.informedCards.map((_, i) => i);
    this.state.seenInformedCardOrigins = blob.seenInformedCardOrigins
      ? blob.seenInformedCardOrigins.map((arr) => [...arr])
      : this.state.seats.map((_, i) =>
          i < this.state.informedCardOrigin.length
            ? [this.state.informedCardOrigin[i]!]
            : [],
        );
    this.state.publicCards = blob.publicCards ? [...blob.publicCards] : [];
    this.state.publicRevealed = blob.publicRevealed ? [...blob.publicRevealed] : [];
    this.state.phase = blob.phase ?? 0;
    this.state.startedAt = blob.startedAt ?? this.state.startedAt;
    this.state.nextEventAt = blob.nextEventAt ?? null;
    this.state.graceTimerEndsAt = blob.graceTimerEndsAt ?? null;
    this.state.endGameAt = blob.endGameAt ?? null;
    this.state.contracts = (blob.contracts ?? []).map((c) => ({
      id: asContractId(c.id),
      name: c.name,
      description: c.description,
      payoffSource: c.payoffSource,
      payoffHash: c.payoffHash,
    })) as ContractDef[];
    this.state.eventQueue = (blob.eventQueue ?? []).map((e) => ({ ...e })) as EventQueueEntry[];
    this.state.botEntities = (blob.botEntities ?? []).map((b) => ({ ...b }));
    this.state.botGroups = (blob.botGroups ?? []).map((g) => ({ ...g }));
    this.state.displayNames = { ...(blob.displayNames ?? {}) };
    this.state.codeBook = { ...(blob.codeBook ?? {}) };
    this.state.positions = {};
    for (const [k, m] of Object.entries(blob.positions ?? {})) {
      this.state.positions[k] = { ...m } as Record<ContractId, number>;
    }
    this.state.cash = { ...(blob.cash ?? {}) };
    // Legacy saves predate `restingOrderId`; sentinel it so attribution
    // helpers fail to match against any live order set (matches the
    // "old trade can't be claimed by any current sub-instance" intuition).
    this.state.trades = (blob.trades ?? []).map((t) => {
      const raw = t as Trade & { restingOrderId?: OrderId };
      return { ...raw, restingOrderId: raw.restingOrderId ?? asOrderId("__legacy") };
    });
    this.state.nextOrderSeq = blob.nextOrderSeq ?? 1;
    this.state.nextTradeSeq = blob.nextTradeSeq ?? 1;
    this.state.settlements = blob.settlements
      ? ({ ...blob.settlements } as Record<ContractId, number>)
      : null;
    this.state.finalPnl = blob.finalPnl ? { ...blob.finalPnl } : null;
    this.state.actionLog = blob.actionLog ? blob.actionLog.slice() : [];
    this.state.nextActionSeq =
      blob.nextActionSeq ?? this.state.actionLog.length + 1;

    // Rebuild order books: levels carry order copies; ordersById is
    // relinked to the SAME order references so cancel/match operations
    // see consistent qty mutations.
    this.state.books = {};
    for (const [cid, sb] of Object.entries(blob.books ?? {})) {
      this.state.books[asContractId(cid)] = restoreBook(sb);
    }

    // Re-arm timers. The saved targets are wallclock; if `now` is past
    // the target (process slept), `Math.max(0, …)` fires immediately.
    if (this.eventTimer !== null) { this.clock.cancel(this.eventTimer); this.eventTimer = null; }
    if (this.endTimer !== null) { this.clock.cancel(this.endTimer); this.endTimer = null; }
    if (this.graceTimer !== null) { this.clock.cancel(this.graceTimer); this.graceTimer = null; }
    if (this.state.status === "playing") {
      const now = this.clock.now();
      if (this.state.options.eventMode === "auto") {
        if (this.state.endGameAt !== null) {
          this.endTimer = this.clock.schedule(
            Math.max(0, this.state.endGameAt - now),
            () => this.onAutoEndGameTimer(),
          );
        } else if (this.state.nextEventAt !== null) {
          this.eventTimer = this.clock.schedule(
            Math.max(0, this.state.nextEventAt - now),
            () => this.onAutoEventTimer(),
          );
        }
      }
      if (this.state.graceTimerEndsAt !== null) {
        this.graceTimer = this.clock.schedule(
          Math.max(0, this.state.graceTimerEndsAt - now),
          () => {
            this.graceTimer = null;
            this.state.graceTimerEndsAt = null;
            if (this.state.status === "playing") this.settleAndFinish();
          },
        );
      }
    }

    this.lastActivityAt = this.clock.now();
  }

  describe(): SessionDescription {
    const required = this.state.options.informedSeats + this.state.options.uninformedSeats;
    return {
      status: this.inPlatformLobby
        ? "lobby"
        : this.state.status === "finished"
          ? "finished"
          : "playing",
      playerCount: this.state.seats.filter((s) => s !== null).length,
      maxPlayers: required,
      spectatorCount: this.spectators.size,
      lastActivityAt: this.lastActivityAt,
      playableSeatIndices: Array.from({ length: required }, (_, i) => i),
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
    // Mirror the rejection into the action log so replays can see
    // intent attempts that didn't actually mutate state.
    const type = intentType(intent);
    const payload =
      intent && typeof intent === "object" && !Array.isArray(intent)
        ? { ...(intent as Record<string, unknown>) }
        : { intent };
    this.logAction(
      { kind: "player", userId },
      type,
      payload,
      { ok: false, reason },
    );
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

/** Best-effort extraction of an intent's `type` for the action log. */
function intentType(intent: unknown): string {
  if (typeof intent === "string") return intent;
  const o = asObject(intent);
  const t = o ? o["type"] : undefined;
  return typeof t === "string" ? t : "UNKNOWN";
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

function saveBook(b: OrderBook): SavedBook {
  return {
    contractId: b.contractId as string,
    lastTradePrice: b.lastTradePrice,
    bids: b.bids.map(saveLevel),
    offers: b.offers.map(saveLevel),
  };
}

function saveLevel(level: PriceLevel): SavedLevel {
  return {
    price: level.price,
    orders: level.orders.map((o) => ({
      id: o.id as string,
      participant: cloneParticipant(o.participant),
      contractId: o.contractId as string,
      side: o.side,
      price: o.price,
      qty: o.qty,
      enteredAt: o.enteredAt,
    })),
  };
}

function restoreBook(sb: SavedBook): OrderBook {
  const ordersById: Record<OrderId, Order> = {};
  const restoreLevel = (sl: SavedLevel): PriceLevel => {
    const orders: Order[] = sl.orders.map((o) => ({
      id: asOrderId(o.id),
      participant: cloneParticipant(o.participant),
      contractId: asContractId(o.contractId),
      side: o.side,
      price: o.price,
      qty: o.qty,
      enteredAt: o.enteredAt,
    }));
    for (const o of orders) ordersById[o.id] = o;
    return { price: sl.price, orders };
  };
  return {
    contractId: asContractId(sb.contractId),
    bids: sb.bids.map(restoreLevel),
    offers: sb.offers.map(restoreLevel),
    lastTradePrice: sb.lastTradePrice,
    ordersById,
  };
}

function cloneParticipant(p: ParticipantId): ParticipantId {
  return p.kind === "player"
    ? { kind: "player", userId: p.userId }
    : { kind: "bot", entityId: p.entityId };
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
      const data = JSON.parse(readFileSync(SHARED_CONTRACTS_PATH, "utf8"));
      cachedSharedContracts = (data?.entries ?? []) as SharedContractEntry[];
    } catch (err) {
      console.warn(
        `[mockery] failed to load shared contracts: ${(err as Error).message}`,
      );
      cachedSharedContracts = [];
    }
  }
  return cachedSharedContracts.find((e) => e.id === refId) ?? null;
}

// Suppress "imported but unused" if Trade is referenced only by type alias.
void undefined as unknown as Trade;
