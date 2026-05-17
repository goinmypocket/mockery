// =============================================================================
// Headless test harness for bot strategies. Lets an author write
// unit-style assertions ("did my market-maker quote both sides? was
// final PnL > 0 on this seed?") without standing up a full session
// by hand.
//
// Usage:
//
//   import { runHeadless } from "../testing/harness";
//   import myStrategy from "./my-strategy";
//
//   const result = runHeadless({
//     strategy: myStrategy,
//     params: { spread: 3 },
//     seed: 7,
//     durationMs: 60_000,
//     contracts: [{ name: "Sum", payoffSource: "return H.sum(cards);" }],
//     opponentBots: [{ strategy: noop, count: 2 }],
//   });
//
//   expect(result.trades.length).toBeGreaterThan(0);
//   expect(result.fillsForMe.length).toBeGreaterThanOrEqual(1);
//   expect(result.finalPnl).toBeGreaterThan(0);
//
// =============================================================================

import { MockerySession } from "../../MockerySession";
import { FakeClock } from "../../clock";
import { BotOrchestrator } from "../runtime";
import type { BotStrategy } from "../api";
import { asTableId, asUserId, type UserId } from "../../../shared/ids";
import type { ResolvedOptions, Trade } from "../../../shared/types";
import { participantKey } from "../../../shared/types";

export interface RunHeadlessArgs {
  /** The strategy under test. Bound to a single bot entity
   *  (`"target-bot"`) at seat-equivalent slot 0 in the bot list. */
  readonly strategy: BotStrategy;
  /** Params bag to validate against the strategy's schema. Defaults
   *  apply for missing keys (same rules as the orchestrator). */
  readonly params?: Readonly<Record<string, unknown>>;
  /** Random seed for the engine RNG (deal order, etc.). Default 1. */
  readonly seed?: number;
  /** Virtual time to simulate, in milliseconds. The fake clock
   *  advances exactly this much; strategy timers fire as expected.
   *  Default 60_000 (one virtual minute). */
  readonly durationMs?: number;
  /** Contracts to install before Start Trading. Each becomes a
   *  separate `SETUP_ADD_CONTRACT`. */
  readonly contracts: ReadonlyArray<{
    readonly name: string;
    readonly payoffSource: string;
    readonly description?: string;
  }>;
  /** Other bots to seat alongside the target. Useful for "play
   *  against passive noise" or "two market-makers in the same
   *  book". */
  readonly opponentBots?: ReadonlyArray<{
    readonly strategy: BotStrategy;
    readonly count: number;
    readonly params?: Readonly<Record<string, unknown>>;
  }>;
  /** How many human seats (filled with synthetic userIds that do
   *  nothing) to add before Start Trading. The engine enforces a
   *  minimum participant count; sometimes you want to be one of
   *  many. Default 3. */
  readonly humanSeats?: number;
  /** Override informedSeats. Defaults to `humanSeats`. */
  readonly informedSeats?: number;
  /** Event queue to fire during the simulation, in order. Defaults
   *  to one ROTATE_INFORMED so the strategy sees at least one
   *  information event. */
  readonly events?: ReadonlyArray<
    | { readonly type: "ROTATE_INFORMED" }
    | { readonly type: "REVEAL_PUBLIC"; readonly slotIndex: number | null }
  >;
}

export interface RunHeadlessResult {
  /** Every trade that printed during the simulation, oldest first. */
  readonly trades: readonly Trade[];
  /** Subset of `trades` where the target bot was buyer or seller. */
  readonly fillsForMe: readonly Trade[];
  /** Target bot's final settled PnL. Null if settlement didn't run
   *  (e.g. duration too short or queue not emptied). */
  readonly finalPnl: number | null;
  /** Final positions per contract id. */
  readonly finalPositions: Readonly<Record<string, number>>;
  /** Final cash (settled if finished, MTM otherwise). */
  readonly finalCash: number;
  /** Phase the engine reached. */
  readonly finalPhase: number;
  /** Final status of the session. */
  readonly status: "playing" | "finished";
}

const HOST = asUserId("host-uid");

/** Synthetic player display names whose two-letter initials are all
 *  distinct, so the alpha code-mode doesn't collide for the harness's
 *  built-in seats. */
const SYNTH_NAMES = ["Alice", "Bob", "Carol", "Dave", "Eve", "Frank", "Gina", "Henry"];
/** Bot entity ids in the engine must be valid 2-letter codes
 *  (`/^[A-Za-z]{2}$/`). Using fixed codes here keeps the harness
 *  predictable: the bot under test is "Tb"; opponents get "O0..Oz"
 *  generated as we go. Two-letter cap = 676 unique entities, far
 *  beyond any sensible test scenario. */
const TARGET_ENTITY_ID = "Tb";

function opponentEntityId(idx: number): string {
  // Walk "O0", "O1", …, "Oz" (alphanumeric second char). For >36
  // opponents bump to two-letter generation; tests realistically
  // top out well below that.
  const chars = "0123456789abcdefghijklmnopqrstuvwxyz";
  if (idx < chars.length) return `O${chars[idx]}`;
  // Fallback: two-letter "Aa", "Ab", … Stays within 26*26 = 676.
  const ascii = "abcdefghijklmnopqrstuvwxyz";
  const i = idx - chars.length;
  return ascii[Math.floor(i / 26)]! + ascii[i % 26]!;
}

/** Runs a single strategy through a full Mockery session against a
 *  fake clock and returns a structured result for assertion. Pure
 *  enough that calling it twice with the same seed produces
 *  identical outputs. */
export function runHeadless(args: RunHeadlessArgs): RunHeadlessResult {
  const clock = new FakeClock(1_000_000);
  const humanSeats = args.humanSeats ?? 3;
  const informedSeats = args.informedSeats ?? humanSeats;
  const opts: ResolvedOptions = {
    cardValues: [1, 2, 9, 10],
    copiesPerValue: 4,
    informedSeats,
    uninformedSeats: Math.max(0, humanSeats - informedSeats),
    publicSlots: 0,
    eventMode: "manual",
    eventIntervalMin: 60,
    eventIntervalMax: 60,
    endGameGraceSec: 0,
    seed: args.seed ?? 1,
    codeMode: "alpha",
    enforceCaseByRole: false,
    identityReveal: "all",
    identityRevealList: [],
  };
  const session = new MockerySession({
    tableId: asTableId("harness-table"),
    hostUserId: HOST,
    options: opts,
    clock,
  });

  // Seat the synthetic humans.
  const userIds: UserId[] = [];
  for (let i = 0; i < humanSeats; i++) {
    const uid = asUserId(`p${i}-uid`);
    userIds.push(uid);
    session.claimSeat(uid, i, { displayName: SYNTH_NAMES[i] ?? `Synth ${i + 1}` });
  }
  session.startGame(HOST);

  // Setup phase: contracts + bot entities + bindings.
  for (const c of args.contracts) {
    session.handleGameMessage(HOST, {
      type: "SETUP_ADD_CONTRACT",
      name: c.name,
      description: c.description ?? "",
      payoffSource: c.payoffSource,
    });
  }
  const events = args.events ?? [{ type: "ROTATE_INFORMED" as const }];
  for (const e of events) {
    session.handleGameMessage(HOST, { type: "SETUP_QUEUE_APPEND", event: e });
  }

  // Assemble strategy table and entity list. Mint opponent entity
  // ids once and reuse the same list for SETUP_SET_BOT_ENTITIES and
  // the subsequent BIND messages so the wire calls agree on names.
  const strategies: Record<string, BotStrategy> = {
    [args.strategy.id]: args.strategy,
  };
  const entityIds: string[] = [TARGET_ENTITY_ID];
  const opponents: Array<{
    entityId: string;
    strategy: BotStrategy;
    params: Readonly<Record<string, unknown>>;
  }> = [];
  let oppCursor = 0;
  for (const opp of args.opponentBots ?? []) {
    strategies[opp.strategy.id] = opp.strategy;
    for (let i = 0; i < opp.count; i++) {
      const entityId = opponentEntityId(oppCursor++);
      entityIds.push(entityId);
      opponents.push({ entityId, strategy: opp.strategy, params: opp.params ?? {} });
    }
  }
  session.handleGameMessage(HOST, { type: "SETUP_SET_BOT_ENTITIES", entityIds });
  session.handleGameMessage(HOST, {
    type: "SETUP_BIND_BOT_STRATEGY",
    entityId: TARGET_ENTITY_ID,
    strategyId: args.strategy.id,
    params: args.params ?? {},
  });
  for (const o of opponents) {
    session.handleGameMessage(HOST, {
      type: "SETUP_BIND_BOT_STRATEGY",
      entityId: o.entityId,
      strategyId: o.strategy.id,
      params: o.params,
    });
  }

  new BotOrchestrator(session, clock, strategies);

  session.handleGameMessage(HOST, { type: "START_TRADING" });

  // Drive the simulation. Fire each queued event after roughly
  // even slices of the duration so the strategy gets a chance to
  // react in between.
  const duration = args.durationMs ?? 60_000;
  const eventCount = events.length;
  const sliceMs = eventCount > 0 ? Math.floor(duration / (eventCount + 1)) : duration;
  for (let i = 0; i < eventCount; i++) {
    clock.advance(sliceMs);
    session.handleGameMessage(HOST, { type: "FIRE_NEXT_EVENT" });
  }
  // Tail slice for any final reactions + settlement.
  clock.advance(duration - sliceMs * eventCount);
  // Attempt to end the game if the queue's empty (host END_GAME is
  // the canonical settlement trigger in manual mode).
  session.handleGameMessage(HOST, { type: "END_GAME" });

  const state = session.getEngineState();
  const myKey = participantKey({ kind: "bot", entityId: TARGET_ENTITY_ID });
  const trades = state.trades.slice();
  const fillsForMe = trades.filter(
    (t) =>
      (t.buyer.kind === "bot" && t.buyer.entityId === TARGET_ENTITY_ID) ||
      (t.seller.kind === "bot" && t.seller.entityId === TARGET_ENTITY_ID),
  );
  return {
    trades,
    fillsForMe,
    finalPnl: state.finalPnl?.[myKey] ?? null,
    finalPositions: state.positions[myKey] ?? {},
    finalCash: state.cash[myKey] ?? 0,
    finalPhase: state.phase,
    status: state.status === "finished" ? "finished" : "playing",
  };
}
