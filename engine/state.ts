// =============================================================================
// GameState — the engine's authoritative shape.
//
// The state is a JSON-able snapshot apart from the RNG, which travels as
// its own opaque structure (pure-rand stores its state inside the generator;
// serialize() re-creates a generator from a saved seed sequence).
// =============================================================================

import type {
  BotEntity,
  CodeBook,
  ContractDef,
  EventQueueEntry,
  OrderBook,
  ResolvedOptions,
  Trade,
} from "../shared/types";
import type { ContractId, UserId } from "../shared/ids";
import { makeRng, type Rng } from "./rng";

export type SessionStatus = "setup" | "playing" | "finished";

export interface GameState {
  status: SessionStatus;
  options: ResolvedOptions;

  /** RNG; mutated in place. State extracted at serialize time. */
  rng: Rng;

  /** Host of the table. The platform tells us; we keep a copy so engine
   *  predicates don't need to thread it through every call. */
  hostUserId: UserId;

  /** Seat assignments. Index 0..informedSeats-1 are informed; the rest
   *  are uninformed. Filled in lobby (by MockerySession) and frozen at
   *  Start Trading. */
  seats: (UserId | null)[];

  /** Per-seat private card values. `informed[i]` is the card held by
   *  seat `i` (only valid for `i < informedSeats`). Rotation reassigns
   *  values across seats; identities (which `cardValues[k]` is which
   *  card) are baked into these values. */
  informedCards: number[];

  /** Public card slot values. Always populated from setup onwards;
   *  `publicRevealed[i]` says whether slot i has been revealed. Hidden
   *  values must be redacted at projection time. */
  publicCards: number[];
  publicRevealed: boolean[];

  /** Active phase. 0 at start of `playing`, ++ on each event firing. */
  phase: number;

  /** Wall-clock, set when transitioning to `playing`. */
  startedAt: number;

  /** Auto mode: ms timestamp when the next event fires. Null in manual
   *  mode (or before `playing`). */
  nextEventAt: number | null;

  /** Manual mode: optional grace timer. Null if not armed. */
  graceTimerEndsAt: number | null;

  /** Auto mode: when the queue is empty and the engine is now waiting
   *  one final interval before settlement, this is the timestamp. */
  endGameAt: number | null;

  /** Contracts pinned to this table. */
  contracts: ContractDef[];

  /** Event queue. Head is the next event to fire. */
  eventQueue: EventQueueEntry[];

  /** Bot entities configured for this game. */
  botEntities: BotEntity[];

  /** Display name per participant, keyed by participantKey. Source for
   *  the `code → display name` mapping that may be redacted. Player
   *  names come from the platform; bot "names" are their entityIds. */
  displayNames: Record<string, string>;

  /** Code book — see engine spec §11. Editable in setup, frozen at
   *  Start Trading. Keyed by participantKey. */
  codeBook: CodeBook;

  /** Per contract order book. */
  books: Record<ContractId, OrderBook>;

  /** Per-participant key → contract → signed position. */
  positions: Record<string, Record<ContractId, number>>;

  /** Per-participant key → cash balance (signed). */
  cash: Record<string, number>;

  /** Append-only trade log. */
  trades: Trade[];

  /** Counter used to mint OrderIds and TradeIds. */
  nextOrderSeq: number;
  nextTradeSeq: number;

  /** Settlement results, populated once status === "finished". */
  settlements: Record<ContractId, number> | null;
  finalPnl: Record<string, number> | null;
}

export function createInitialState(args: {
  options: ResolvedOptions;
  hostUserId: UserId;
  seats: (UserId | null)[];
  now: number;
}): GameState {
  return {
    status: "setup",
    options: args.options,
    rng: makeRng(args.options.seed),
    hostUserId: args.hostUserId,
    seats: args.seats.slice(),
    informedCards: [],
    publicCards: [],
    publicRevealed: [],
    phase: 0,
    startedAt: args.now,
    nextEventAt: null,
    graceTimerEndsAt: null,
    endGameAt: null,
    contracts: [],
    eventQueue: [],
    botEntities: [],
    displayNames: {},
    codeBook: {},
    books: {},
    positions: {},
    cash: {},
    trades: [],
    nextOrderSeq: 1,
    nextTradeSeq: 1,
    settlements: null,
    finalPnl: null,
  };
}
