// =============================================================================
// Per-recipient projection.
//
// Given the authoritative GameState and a viewer's userId, build a
// snapshot the viewer is allowed to see. Cards they shouldn't see are
// nulled, identities they shouldn't see are stripped, and participant
// references are translated from internal participantKeys to public
// 2-letter codes.
//
// The returned shape is the source of truth for what a client renders.
// =============================================================================

import type { ContractId, UserId } from "../shared/ids";
import type {
  BotEntity,
  ContractDef,
  EventQueueEntry,
  EventMode,
  IdentityReveal,
  Order,
  OrderSide,
  ParticipantCode,
  ParticipantId,
  Trade,
} from "../shared/types";
import { participantKey } from "../shared/types";
import type { GameState, SessionStatus } from "./state";
import { midPrice } from "./orderBook";
import { settledPnl, mtmPnl, markPrice } from "./pnl";

export type ViewerRole = "host" | "informed" | "uninformed" | "spectator";

export interface ProjectedSnapshot {
  readonly status: SessionStatus | "lobby";
  readonly tableHostUserId: UserId;
  readonly viewer: ProjectedViewer;

  readonly options: GameState["options"];
  readonly contracts: readonly ContractDef[];
  readonly eventMode: EventMode;
  readonly eventQueue: readonly EventQueueEntry[];
  readonly phase: number;
  readonly msUntilNextEvent: number | null;
  readonly graceTimerMs: number | null;
  readonly identityReveal: IdentityReveal;

  readonly publicCards: ReadonlyArray<number | null>;
  readonly participants: readonly ProjectedParticipant[];
  readonly botEntities: readonly BotEntity[];

  readonly books: Readonly<Record<ContractId, ProjectedBook>>;
  readonly recentTrades: readonly ProjectedTrade[];
  readonly myOpenOrders: readonly Order[];

  readonly positionsByCode: Readonly<Record<ParticipantCode, Record<ContractId, number>>>;
  readonly pnlByCode: Readonly<Record<ParticipantCode, number>>;
  /** Per-contract MTM (or settled) PnL: contractCashFlow + position *
   *  mark/settlement. Sums across contracts equal `pnlByCode[code]`. */
  readonly contractPnlByCode: Readonly<Record<ParticipantCode, Record<ContractId, number>>>;
  readonly marksByContract: Readonly<Record<ContractId, number>>;

  readonly settlements: Readonly<Record<ContractId, number>> | null;
}

export interface ProjectedViewer {
  readonly userId: UserId;
  readonly role: ViewerRole;
  readonly seatIndex: number | null;
  readonly myCard: number | null;          // own private card if informed
  readonly myCode: ParticipantCode | null; // their own code; null for non-participating spectators
}

export interface ProjectedParticipant {
  readonly code: ParticipantCode;
  readonly role: "informed" | "uninformed" | "bot";
  readonly displayName: string | null;     // null when redacted
  /** Internal key, exposed to the host only (for setup-phase intents
   *  that need to address a specific participant). Null for everyone
   *  else, preserving the redaction in §10.4. */
  readonly participantKey: string | null;
}

export interface ProjectedBook {
  readonly contractId: ContractId;
  readonly bids: readonly ProjectedLevel[];
  readonly offers: readonly ProjectedLevel[];
  readonly lastTradePrice: number | null;
  readonly midPrice: number | null;
}

export interface ProjectedLevel {
  readonly price: number;
  readonly size: number;
  readonly parties: ReadonlyArray<{ readonly code: ParticipantCode; readonly qty: number }>;
}

export interface ProjectedTrade {
  readonly id: string;
  readonly ts: number;
  readonly phase: number;
  readonly contractId: ContractId;
  readonly buyerCode: ParticipantCode;
  readonly sellerCode: ParticipantCode;
  readonly side: OrderSide;
  readonly price: number;
  readonly qty: number;
  readonly aggressor: "buyer" | "seller";
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export interface ProjectArgs {
  readonly state: GameState;
  readonly viewerUserId: UserId;
  readonly platformStatus: "lobby" | "playing" | "finished";
  /** ms until next event — auto mode only. Pulled from the session's
   *  scheduler since state.nextEventAt is a wallclock target. */
  readonly msUntilNextEvent: number | null;
  /** ms remaining on the grace timer, or null if not armed. */
  readonly graceTimerMs: number | null;
  /** How many trades to include in `recentTrades`. */
  readonly tradeTail?: number;
}

export function project(args: ProjectArgs): ProjectedSnapshot {
  const s = args.state;
  const viewer = computeViewer(s, args.viewerUserId);
  const showNames = identityVisibleTo(s, args.viewerUserId);

  const codeFor = (id: ParticipantId) => s.codeBook[participantKey(id)] ?? "??";
  const nameFor = (key: string): string | null => {
    if (showNames) return s.displayNames[key] ?? null;
    if (key === participantKey({ kind: "player", userId: args.viewerUserId })) {
      return s.displayNames[key] ?? null;
    }
    return null;
  };

  const isHost = args.viewerUserId === s.hostUserId;
  const participants: ProjectedParticipant[] = [];
  for (let i = 0; i < s.seats.length; i++) {
    const u = s.seats[i];
    if (!u) continue;
    const key = participantKey({ kind: "player", userId: u });
    participants.push({
      code: s.codeBook[key] ?? "??",
      role: i < s.options.informedSeats ? "informed" : "uninformed",
      displayName: nameFor(key),
      participantKey: isHost ? key : null,
    });
  }
  for (const e of s.botEntities) {
    const key = participantKey({ kind: "bot", entityId: e.entityId });
    participants.push({
      code: s.codeBook[key] ?? "??",
      role: "bot",
      displayName: nameFor(key),
      participantKey: isHost ? key : null,
    });
  }

  // Public cards: redact hidden ones unless we're at finished (then all
  // values are revealed by §9 settlement).
  const publicCards: (number | null)[] = s.publicCards.map((v, i) =>
    s.publicRevealed[i] ? v : null,
  );

  // Books with codes.
  const books: Record<ContractId, ProjectedBook> = {};
  for (const [cid, book] of Object.entries(s.books)) {
    const projectLevel = (lvl: typeof book.bids[number]): ProjectedLevel => ({
      price: lvl.price,
      size: lvl.orders.reduce((acc, o) => acc + o.qty, 0),
      parties: lvl.orders.map((o) => ({ code: codeFor(o.participant), qty: o.qty })),
    });
    books[cid as ContractId] = {
      contractId: cid as ContractId,
      bids: book.bids.map(projectLevel),
      offers: book.offers.map(projectLevel),
      lastTradePrice: book.lastTradePrice,
      midPrice: midPrice(book),
    };
  }

  // Recent trades — by default ship the entire trade log so the TnS
  // panel survives page refreshes. Callers can still pass a smaller
  // `tradeTail` for bandwidth-sensitive paths (e.g. bot snapshots).
  const tail = args.tradeTail ?? s.trades.length;
  const recent = s.trades.slice(-tail).map<ProjectedTrade>((t) => ({
    id: t.id as unknown as string,
    ts: t.ts,
    phase: t.phase,
    contractId: t.contractId,
    buyerCode: codeFor(t.buyer),
    sellerCode: codeFor(t.seller),
    side: t.aggressor === "buyer" ? "buy" : "sell",
    price: t.price,
    qty: t.qty,
    aggressor: t.aggressor,
  }));

  // Positions/PnL/marks keyed by code.
  const positionsByCode: Record<ParticipantCode, Record<ContractId, number>> = {};
  const pnlByCode: Record<ParticipantCode, number> = {};
  const contractPnlByCode: Record<ParticipantCode, Record<ContractId, number>> = {};
  const marksByContract: Record<ContractId, number> = {};
  for (const cid of Object.keys(s.books) as ContractId[]) {
    marksByContract[cid] = markPrice(s, cid);
  }

  // Reconstruct per-(participant, contract) cash flow from the trade
  // log so we can split PnL by contract. State.cash is global (not
  // per-contract), so we walk trades. Pre-buys subtract; sells add.
  const cashFlowByKeyContract: Record<string, Record<ContractId, number>> = {};
  const bump = (key: string, cid: ContractId, delta: number): void => {
    if (!cashFlowByKeyContract[key]) cashFlowByKeyContract[key] = {};
    cashFlowByKeyContract[key][cid] = (cashFlowByKeyContract[key][cid] ?? 0) + delta;
  };
  for (const t of s.trades) {
    const buyerKey = participantKey(t.buyer);
    const sellerKey = participantKey(t.seller);
    const cash = t.price * t.qty;
    bump(buyerKey, t.contractId, -cash);
    bump(sellerKey, t.contractId, +cash);
  }

  const allKeys = new Set<string>([
    ...Object.keys(s.positions),
    ...Object.keys(s.cash),
    ...Object.values(s.codeBook).length === 0 ? [] : Object.keys(s.codeBook),
  ]);
  for (const key of allKeys) {
    const code = s.codeBook[key];
    if (!code) continue;
    const pos = s.positions[key] ?? {};
    positionsByCode[code] = { ...pos };
    if (s.status === "finished" && s.settlements) {
      pnlByCode[code] = settledPnl(s, keyToParticipant(key), s.settlements);
    } else {
      pnlByCode[code] = mtmPnl(s, keyToParticipant(key));
    }

    // Per-contract PnL = cashFlow[c] + position[c] * (settle|mark[c]).
    const flows = cashFlowByKeyContract[key] ?? {};
    const perContract: Record<ContractId, number> = {};
    const contractIds = new Set<ContractId>([
      ...(Object.keys(flows) as ContractId[]),
      ...(Object.keys(pos) as ContractId[]),
      ...(Object.keys(marksByContract) as ContractId[]),
    ]);
    for (const cid of contractIds) {
      const cashFlow = flows[cid] ?? 0;
      const position = pos[cid] ?? 0;
      const valuePerUnit = s.status === "finished" && s.settlements
        ? (s.settlements[cid] ?? 0)
        : (marksByContract[cid] ?? 0);
      perContract[cid] = cashFlow + position * valuePerUnit;
    }
    contractPnlByCode[code] = perContract;
  }

  // Viewer's own open orders.
  const myKey = participantKey({ kind: "player", userId: args.viewerUserId });
  const myOpenOrders: Order[] = [];
  for (const book of Object.values(s.books)) {
    for (const order of Object.values(book.ordersById)) {
      if (participantKey(order.participant) === myKey) myOpenOrders.push(order);
    }
  }

  return {
    status: args.platformStatus === "lobby" ? "lobby" : s.status,
    tableHostUserId: s.hostUserId,
    viewer,
    options: s.options,
    contracts: s.contracts,
    eventMode: s.options.eventMode,
    eventQueue: s.eventQueue,
    phase: s.phase,
    msUntilNextEvent: args.msUntilNextEvent,
    graceTimerMs: args.graceTimerMs,
    identityReveal: s.options.identityReveal,
    publicCards,
    participants,
    botEntities: s.botEntities,
    books,
    recentTrades: recent,
    myOpenOrders,
    positionsByCode,
    pnlByCode,
    contractPnlByCode,
    marksByContract,
    settlements: s.settlements,
  };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function computeViewer(s: GameState, viewerUserId: UserId): ProjectedViewer {
  const seatIndex = s.seats.findIndex((u) => u === viewerUserId);
  let role: ViewerRole;
  if (seatIndex >= 0) {
    role = seatIndex < s.options.informedSeats ? "informed" : "uninformed";
  } else if (viewerUserId === s.hostUserId) {
    role = "host";
  } else {
    role = "spectator";
  }
  const myCard =
    role === "informed" && s.informedCards.length > seatIndex
      ? s.informedCards[seatIndex]!
      : null;
  const myKey = participantKey({ kind: "player", userId: viewerUserId });
  return {
    userId: viewerUserId,
    role,
    seatIndex: seatIndex >= 0 ? seatIndex : null,
    myCard,
    myCode: s.codeBook[myKey] ?? null,
  };
}

function identityVisibleTo(s: GameState, viewerUserId: UserId): boolean {
  switch (s.options.identityReveal) {
    case "all":
      return true;
    case "host":
      return viewerUserId === s.hostUserId;
    case "listed":
      return s.options.identityRevealList.includes(viewerUserId);
  }
}

function keyToParticipant(key: string): ParticipantId {
  if (key.startsWith("p:")) {
    return { kind: "player", userId: key.slice(2) as UserId };
  }
  return { kind: "bot", entityId: key.slice(2) };
}
