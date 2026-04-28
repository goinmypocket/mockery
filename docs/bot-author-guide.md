# Mockery — bot author's guide

A bot is a piece of TypeScript that decides when to place, modify,
and cancel orders inside a Mockery game. Bots run **server-side**,
inside the Mockery server module, and the engine treats them as
ordinary participants — no separate auth, no separate wire
protocol, and the same redaction rules as uninformed humans.

This guide is the contract you write your bots against. It pairs
with `game-spec.md` (the engine authority) and `game-ui-spec.md`
(the player-facing UI).

> **Status:** v0.1 of the bot API. The interface is stable in
> intent; concrete TypeScript names are subject to small renames
> during the first implementation pass.

---

## 1. Concepts

- **Bot strategy** — TypeScript code, written by you, that
  implements the `BotStrategy` interface (§4). One file per
  strategy lives in `mockery/server/bots/strategies/`.
- **Entity** — a stable string brand under which trades are
  recorded (e.g. `"ABC"`). The engine identifies traders by
  entity, not by strategy. Multiple entities may share a strategy;
  multiple strategies may share an entity (the bot orchestrator
  chooses).
- **Bot orchestrator** — the server-side runtime that owns the
  lifecycle: it loads strategies from the registry, creates one
  **bot instance** per `(table, entityId)` pair, wires events
  from the engine into the strategy's callbacks, and routes the
  strategy's actions back into the engine.
- **Bot instance** — a strategy instantiated for one specific
  entity in one specific table. Each instance has its own
  in-memory state, separate from other instances of the same
  strategy.

A strategy is **uninformed**. It never sees private cards or
unrevealed public cards. The same redaction the engine applies to
human spectators applies to bot instances.

## 2. Where bot code lives

```
mockery/
└── server/
    └── bots/
        ├── api.ts              # the BotStrategy / BotContext types (you import from here)
        ├── runtime.ts          # the orchestrator (you do not edit)
        ├── registry.ts         # registers strategies (one entry per strategy)
        └── strategies/
            ├── README.md       # quick orientation
            ├── noop.ts         # ships with v0.1, useful as a template
            ├── random-quoter.ts
            └── <your-bot>.ts   # your strategy
```

Adding a new strategy is two steps:

1. Create a file in `strategies/` that exports a default
   `BotStrategy`.
2. Add an entry to `registry.ts` so the host's setup UI can pick
   it.

The strategy id is the registry key (e.g. `"random-quoter"`). It's
what the host picks in the setup module's bot-entities editor.

## 3. Strategy registration

`registry.ts` looks like:

```ts
import noop from "./strategies/noop";
import randomQuoter from "./strategies/random-quoter";
import yours from "./strategies/your-bot";

export const STRATEGIES = {
  "noop":           noop,
  "random-quoter":  randomQuoter,
  "your-bot":       yours,
} as const satisfies Record<string, BotStrategy>;

export type StrategyId = keyof typeof STRATEGIES;
```

The orchestrator looks up the host's choice (`SETUP_BIND_BOT_STRATEGY`)
in this map. An unknown id is rejected at setup time.

## 4. The `BotStrategy` interface

```ts
import type {
  BotStrategy,
  BotContext,
  MarketSnapshot,
  Trade,
  GameEvent,
  GameResult,
  PlaceArgs,
  Result,
} from "../api";

const myBot: BotStrategy = {
  /** Stable id used in the strategy registry. */
  id: "my-bot",

  /** Human label shown in the host's setup picker. */
  displayName: "My example bot",

  /** Optional. Called once when the bot instance is attached to a
   *  game (after the playing phase begins). Use it to set up state
   *  on the supplied `ctx`. */
  onStart(ctx: BotContext): void {
    ctx.local.set("inventoryTarget", 0);
  },

  /** Called every time the market data snapshot changes
   *  (book delta, trade print, event, timer tick). Snapshots are
   *  delivered at most ~1× per 50ms; multiple raw deltas may be
   *  coalesced into a single snapshot. */
  onMarketData(ctx: BotContext, snap: MarketSnapshot): void {
    // place orders, etc.
  },

  /** Optional. Called for every trade print, even ones the bot
   *  was a counterparty on. Strategies that only react to the
   *  market in `onMarketData` can omit this. */
  onTrade(ctx: BotContext, trade: Trade): void { },

  /** Optional. Called when an event fires (rotate or reveal).
   *  Use this to wipe stale priors after the information set
   *  changes. */
  onEvent(ctx: BotContext, event: GameEvent): void { },

  /** Optional. Called once when the game settles. Useful for
   *  logging post-mortems. The bot's `ctx` actions are no-ops at
   *  this point. */
  onGameOver(ctx: BotContext, result: GameResult): void { },
};

export default myBot;
```

All callbacks are synchronous in v0.1. (See §11 for why.)

## 5. The `BotContext`

The same `ctx` is passed into every callback for a given bot
instance. It carries identity, the latest market snapshot, an
action API, an introspection API, and a per-instance scratchpad.

```ts
interface BotContext {
  // ── identity ────────────────────────────────────────────────
  readonly entityId: string;
  readonly tableId: TableId;

  // ── latest market snapshot ──────────────────────────────────
  readonly snapshot: MarketSnapshot;

  // ── action API (returns synchronously) ──────────────────────
  placeLimit(args: PlaceArgs): Result<{ orderId: OrderId; fills: Trade[] }>;
  placeIoc(args: PlaceArgs):   Result<{ orderId: OrderId; fills: Trade[] }>;
  cancel(orderId: OrderId):    Result;
  cancelAllMy():               Result<{ cancelled: number }>;

  // ── introspection ───────────────────────────────────────────
  myPosition(contractId: ContractId): number;
  myCash():                          number;
  myMtmPnl():                        number;
  myOpenOrders():                    readonly Order[];

  // ── per-instance scratchpad ─────────────────────────────────
  // strongly-typed key/value store; survives across callbacks
  // for this instance only. Reset on game end. NOT persisted in
  // the table save.
  readonly local: Map<string, unknown>;

  // ── timer helpers (single-fire) ─────────────────────────────
  // schedule a callback to run after `ms`. Returns a handle the
  // strategy can cancel. Timers fire even if no market data
  // arrives.
  setTimer(ms: number, fn: () => void): TimerHandle;
  clearTimer(handle: TimerHandle): void;
}

interface PlaceArgs {
  contractId: ContractId;
  side: "buy" | "sell";
  qty: number;          // positive integer
  price: number;        // integer
}
```

`Result` is the platform's standard `{ ok: true, ... }` /
`{ ok: false, reason }` shape — same as elsewhere in the system.

## 6. `MarketSnapshot`

The exhaustive view a bot has into a game.

```ts
interface MarketSnapshot {
  ts: number;                      // server ms
  phase: number;
  status: "playing" | "finished";

  // ── public information ──────────────────────────────────────
  cardValues:     number[];        // the deck's distinct values
  copiesPerValue: number;
  publicCards:    (number | null)[];   // null for hidden slots
  contracts:      ContractDef[];   // including payoffSource
  participants:   ParticipantSummary[];
  eventQueue:     EventQueueEntry[];
  eventMode:      "auto" | "manual";
  msUntilNextEvent: number | null; // null in manual mode

  // ── books ───────────────────────────────────────────────────
  // Per contract, the FIFO levels on each side. A bot sees real
  // participant ids (player userId or bot entityId) — same as
  // human players see.
  books: Record<ContractId, BookSnapshot>;

  // ── trade tape ──────────────────────────────────────────────
  recentTrades: Trade[];           // last 100 prints

  // ── this bot's view ─────────────────────────────────────────
  myPositions: Record<ContractId, number>;
  myCash:      number;
  myMtmPnl:    number;
  myOpenOrders: Order[];
}

interface BookSnapshot {
  contractId: ContractId;
  bids: PriceLevel[];   // sorted descending by price
  offers: PriceLevel[]; // sorted ascending by price
  lastTradePrice: number | null;
  midPrice: number | null;        // (bestBid + bestOffer) / 2 if both
}

interface PriceLevel {
  price: number;
  size: number;                   // total at this level
  parties: { participant: ParticipantId; qty: number }[]; // FIFO
}
```

Snapshots are immutable. The orchestrator constructs a new
snapshot before each callback; mutating fields is a no-op against
the engine.

## 7. Lifecycle

For one bot instance:

```
table enters playing
  └─ onStart(ctx)
[stream of:]
  ├─ onMarketData(ctx, snap)        // many times per phase
  ├─ onTrade(ctx, trade)            // every print
  ├─ onEvent(ctx, event)            // each rotate/reveal
  └─ scheduled timers fire
table enters finished
  └─ onGameOver(ctx, result)
detached
```

A bot instance is destroyed when the game is finished. If the table
is reloaded from a save, instances are re-created with a fresh
`ctx.local` — there is no save/load hook for bot state in v0.1.

## 8. Orchestrator → engine routing

The orchestrator routes strategy intents into the engine through
an internal API on `MockerySession`:

```ts
session.submitBotIntent(entityId, {
  kind: "PLACE_LIMIT",
  contractId, side, qty, price,
});
```

The engine validates exactly the same way it validates a player
intent: same self-trade rules, same FIFO matching, same
`INTENT_REJECTED` shape on failure (returned synchronously to the
strategy as a `Result`).

Bots cannot submit setup-phase intents, host intents, library
intents, or any platform-level intent. They are only traders.

## 9. Multi-entity, multi-strategy

Two patterns the orchestrator supports out of the box:

### 9.1 One strategy, many entities

A single strategy file, instantiated under several entity ids:

```ts
// in setup, the host adds three entities and binds all to "random-quoter":
{ entityId: "ABC", strategyId: "random-quoter" }
{ entityId: "XYZ", strategyId: "random-quoter" }
{ entityId: "DEF", strategyId: "random-quoter" }
```

The orchestrator creates three independent instances, each with
its own `ctx.local`. They cannot see each other's state.

### 9.2 Many strategies, one entity

Less common but supported. Two strategies bound to the same
entity see the same positions/orders/PnL, but each gets its own
`ctx.local`. Both submit intents under the same entity id. The
engine cannot tell them apart — they look like one big trader.

This is configured at orchestrator level, not in the host UI in
v0.1.

## 10. A worked example: random quoter

```ts
// server/bots/strategies/random-quoter.ts
import type { BotStrategy } from "../api";

const randomQuoter: BotStrategy = {
  id: "random-quoter",
  displayName: "Random quoter (educational)",

  onStart(ctx) {
    // re-quote every 5 seconds
    const tick = () => {
      requote(ctx);
      ctx.local.set("timer", ctx.setTimer(5000, tick));
    };
    tick();
  },

  onEvent(ctx) {
    // wipe orders on every event so the bot starts the new
    // information regime fresh
    ctx.cancelAllMy();
  },

  onGameOver(ctx) {
    const t = ctx.local.get("timer");
    if (t) ctx.clearTimer(t as never);
  },
};

function requote(ctx) {
  ctx.cancelAllMy();
  for (const c of ctx.snapshot.contracts) {
    const mid = ctx.snapshot.books[c.id]?.midPrice ?? 25;
    const spread = 2;
    ctx.placeLimit({ contractId: c.id, side: "buy",  qty: 1, price: Math.floor(mid - spread) });
    ctx.placeLimit({ contractId: c.id, side: "sell", qty: 1, price: Math.ceil(mid + spread) });
  }
}

export default randomQuoter;
```

Key things this illustrates:

- **Local state via `ctx.local`** — the timer handle outlives the
  callback that created it.
- **Self-cancellation on event** — `onEvent` is the right hook to
  wipe stale priors.
- **No async I/O** — the strategy reads from `ctx.snapshot`, not
  from the network. The orchestrator is the only thing that
  touches the engine boundary.

## 11. Performance and concurrency

- All strategy callbacks for a given bot instance run on the
  engine's main loop. **They must return quickly.** A soft target
  is < 5 ms per callback; the orchestrator will log a warning at
  20 ms.
- Strategies cannot start their own threads or workers in v0.1.
  If you need heavy computation, time-slice it across snapshots
  using `setTimer`.
- Strategies are **not** sandboxed (unlike contract `payoff`s) —
  they're trusted server-side TypeScript checked into the repo.
  Don't `require("child_process")` and ruin everything.

## 12. Error handling

- A thrown exception inside a callback is logged and the callback
  is treated as a no-op for that snapshot. The instance survives
  and continues to receive callbacks.
- Repeated throws (`> 5` consecutive) put the instance into a
  **quarantined** state: it stops receiving callbacks and a
  system row appears in TNS. The orchestrator does not unwind
  the bot's existing positions.

## 13. Testing your bot

A minimal harness (planned):

```ts
import { runHeadless } from "../../tests/bot-harness";
import myBot from "./strategies/my-bot";

it("never sends a negative-qty order", async () => {
  const result = await runHeadless({
    strategy: myBot,
    seed: 1,
    durationSec: 600,
    contracts: [...],
  });
  expect(result.violations).toEqual([]);
});
```

The harness will run a deterministic in-process game with stub
players (or other bots) and replay the trade tape, asserting
invariants.

(Harness implementation tracked in §14 Q1.)

## 14. Open questions

1. **Test harness shape.** Do we want a deterministic
   replay harness (described above), a Monte-Carlo runner, or
   both? v0.1 plans the replay harness only.
2. **Async callbacks.** Synchronous-only is the simplest contract
   and the easiest to reason about. If a strategy needs to call
   out to e.g. a model server, we'd need an async escape hatch.
   Demand-driven; not implemented in v0.1.
3. **Bot persistence.** Currently bot `ctx.local` is wiped on
   game-load (the orchestrator re-instantiates from scratch).
   Should bots get their own slot in `MockerySave`?
4. **Hot reload.** During development, can we reload a strategy
   file without restarting the platform? Probably yes via Vite
   HMR on the server module, but it's not designed for v0.1.
5. **Per-entity rate limits.** Should the orchestrator enforce
   a max-orders-per-second per entity, or trust strategy
   authors?

