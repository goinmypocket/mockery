# Bot modularity — architectural state

This document captures the bot subsystem's contract after the
modularity refactor. It is a peer to `bot-author-guide.md` (which is
a how-to from the author's seat); this doc is the *what* and *why*
for someone making engine- or API-level changes.

## TL;DR

A new strategy is a single file that exports `default <BotStrategy>`,
plus one line in `registry.ts`. The strategy file declares its tunable
parameters as a `paramsSchema` and reads typed `ctx.params` inside its
handlers. Common patterns (best-bid, best-offer, midOrFallback, ladder
quoting, requote cadence) come from `bots/helpers/`; the strategy
should never reach into `engine/` directly. Unit tests for a strategy
run through `bots/testing/harness.ts` — no need to hand-wire a
`MockerySession`.

## Module layout

```
mockery/server/bots/
├── api.ts             # Public surface for strategy authors:
│                      #   BotStrategy, BotContext, MarketSnapshot,
│                      #   ParamsSchema/ParamSpec, lifecycle hooks,
│                      #   resolveParams() validator.
├── runtime.ts         # BotOrchestrator: installs SessionHooks,
│                      #   instantiates bots at game start, dispatches
│                      #   lifecycle callbacks, bounds re-entrancy and
│                      #   quarantines throwing strategies.
├── registry.ts        # Hand-curated `STRATEGIES` table + a
│                      #   `validateRegistry()` self-check that runs
│                      #   at module load so a misregistered strategy
│                      #   fails fast.
├── helpers/           # Stateless building blocks. Strategies import
│   ├── book.ts        #   from `../helpers`; these never touch engine
│   ├── quoting.ts     #   internals — only pure functions over
│   ├── trades.ts      #   MarketSnapshot / BotContext.
│   ├── cadence.ts     #
│   └── index.ts       # Barrel re-export.
├── strategies/        # One file per strategy. Exports a default
│   ├── noop.ts        #   BotStrategy. Filename MUST match its `id`.
│   └── random-quoter.ts
└── testing/
    └── harness.ts     # runHeadless() — drives a full Mockery
                       #   session against a FakeClock and returns a
                       #   structured result for assertions.
```

## The strategy contract

```typescript
interface BotStrategy<P = Params> {
  readonly id: string;                 // matches filename
  readonly displayName: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly category?: "market-maker" | "directional" | "noise" | "test" | "other";
  readonly paramsSchema?: ParamsSchema;

  onStart?       (ctx: BotContext<P>): void;
  onMarketData?  (ctx: BotContext<P>, snap: MarketSnapshot): void;
  onBookUpdate?  (ctx: BotContext<P>, contractId: ContractId): void;
  onTrade?       (ctx: BotContext<P>, trade: BotTrade): void;
  onMyFill?      (ctx: BotContext<P>, trade: BotTrade, side: OrderSide): void;
  onEvent?       (ctx: BotContext<P>, event: GameEvent): void;
  onPhaseChange? (ctx: BotContext<P>, oldPhase: number, newPhase: number): void;
  onGameOver?    (ctx: BotContext<P>, result: GameResult): void;
}
```

Lifecycle hooks fire single-threaded; the orchestrator wraps each
call so a throw doesn't bring down the session (5 throws and the
instance is quarantined). All hooks are optional.

### Hook selection guide

| Need                                         | Use                           |
| -------------------------------------------- | ----------------------------- |
| One-time setup                               | `onStart`                     |
| React to any state change                    | `onMarketData` (coarse)       |
| React only when *my* fill prints             | `onMyFill`                    |
| React when top of book moved                 | `onBookUpdate(contractId)`    |
| React to every trade (tape reading)          | `onTrade`                     |
| React to rotate / reveal                     | `onEvent`                     |
| Reset per-phase state                        | `onPhaseChange`               |
| Wall-clock cadence (requote every N ms)      | `cadence()` helper            |
| Cleanup                                      | `onGameOver` (timers also auto-cancel) |

## Parameters

A strategy declares its tunables as a `paramsSchema`. The host passes
per-instance values via `SETUP_BIND_BOT_STRATEGY { params }`; the
orchestrator validates against the schema at game start (defaults
fill in missing keys, bounds enforce min/max, unknown keys are
rejected) and exposes the resolved bag on `ctx.params`.

```typescript
type QuoterParams = Readonly<{
  spread: number;
  requoteMs: number;
}>;

const myBot: BotStrategy<QuoterParams> = {
  id: "my-bot",
  displayName: "My bot",
  paramsSchema: {
    spread:    { kind: "int", min: 1, max: 50, default: 2,
                 label: "Spread (half-width)" },
    requoteMs: { kind: "int", min: 250, max: 60000, default: 5000,
                 label: "Requote interval (ms)" },
  },
  onStart(ctx) {
    cadence(ctx, ctx.params.requoteMs, () => requote(ctx, ctx.params.spread));
  },
};
```

Two bot entities can run the same strategy with different params —
the host UI binds `BotEntity.params` per instance. Same `STRATEGIES`
entry, multiple configurations in one game.

> **Note on the typed generic.** `BotStrategy<P>` is invariant in
> `P` because `P` shows up in callback parameters. To keep the
> registry (`Record<string, BotStrategy<Params>>`) able to hold
> instances with different `P`s, the registry stores them as
> `AnyBotStrategy = BotStrategy<Params>` and authors cast their
> typed strategy at the registry entry. Inside the strategy file
> the typed `P` flows through `ctx.params` correctly; only the
> registry sees the erased form. Also note: declare `P` as a
> `type` alias (not an `interface`) so it satisfies the open
> `Record<string, unknown>` constraint TypeScript expects.

## Helpers

Strategies should compose, not rewrite. Reach for these instead of
inlining the same math you saw in `random-quoter.ts`.

### `helpers/book.ts`
- `bestBid(snap, contractId)`, `bestOffer(snap, contractId)`
- `touch(snap, contractId) → { bid, offer }`
- `spread(snap, contractId) → number | null`
- `midOrFallback(snap, contractId, fallback?) → number | null`
- `myRestingAt(snap, contractId, side, price) → number`
- `myOrderIdsAt(snap, contractId, side, price) → readonly OrderId[]`
- `allBooks(snap)` — iterator over every book in the snapshot

### `helpers/quoting.ts`
- `twoSided(center, halfSpread, size) → { bid, offer }`
- `ladder({ center, halfSpread, step, levels, size }) → readonly Quote[]`
- `sizeUnderLimit({ side, baseQty, myPosition, positionLimit }) → number`

### `helpers/trades.ts`
- `isMyTrade(snap, trade) → boolean`
- `lastTrade(snap, contractId) → BotTrade | undefined`
- `recentVwap(snap, contractId, n) → number | null`
- `netAggressorVolume(snap, contractId, n) → number`

### `helpers/cadence.ts`
- `cadence(ctx, ms, fn)` — schedules `fn` immediately then every `ms`, owning the timer re-arm in `ctx.local`.
- `stopCadence(ctx)` — cancels an active cadence (no-op if none).

All helpers are exported from the barrel `from "../helpers"`. Strategies
should never import from `../runtime`, `../../engine/...`, or
`../../server/...`.

## Snapshot contract

`MarketSnapshot` is the single object a strategy reads to understand
the world. Key fields:

| Field | What |
| --- | --- |
| `myCode` | The bot's own participant code, matching codes in `books[*].parties[*].code` and trade prints. |
| `books` | Per-contract `BookSnapshot` (bids, offers, lastTradePrice, midPrice). |
| `recentTrades` | Up to the last 100 trades, oldest first. |
| `myPositions` / `myCash` / `myMtmPnl` / `myOpenOrders` | This bot's exposure. |
| `phase` / `eventQueue` / `eventMode` / `msUntilNextEvent` | Where the game is. |
| `participants` | All seated humans + bots with role + code. `displayName` is always null for bots (redaction). |

The snapshot is rebuilt fresh before every callback (`refreshContext`
in `runtime.ts`). For two bots in the same tick the orchestrator
currently rebuilds twice — see *Known limits* below.

## Action API on `BotContext`

| Call | Returns | Notes |
| --- | --- | --- |
| `placeLimit({ contractId, side, qty, price })` | `OpResult<{ orderId, fills }>` | `orderId` is non-null if any rests; `fills` lists what matched. |
| `placeIoc({ contractId, side, qty, price })` | `OpResult<{ fills }>` | Never rests. |
| `cancel(orderId)` | `OpResult<void>` | |
| `cancelAllMy()` | `OpResult<{ cancelled }>` | |
| `myPosition(contractId)` / `myCash()` / `myMtmPnl()` / `myOpenOrders()` | live reads | Direct from engine, no snapshot dance. |
| `setTimer(ms, fn)` / `clearTimer(handle)` | `TimerHandle` | Auto-cancelled at `onGameOver`. |

## Testing

```typescript
import { runHeadless } from "../testing/harness";
import myStrategy from "./my-strategy";

const result = runHeadless({
  strategy: myStrategy,
  params: { spread: 3 },
  seed: 7,
  durationMs: 60_000,
  contracts: [{ name: "Sum", payoffSource: "return H.sum(cards);" }],
  opponentBots: [{ strategy: noop, count: 2 }],
});

expect(result.status).toBe("finished");
expect(result.fillsForMe.length).toBeGreaterThanOrEqual(1);
expect(result.finalPnl).toBeGreaterThan(0);
```

The harness sets up a `MockerySession` with a deterministic
`FakeClock`, seats synthetic humans, binds the strategy as a bot
entity (`Tb`), optionally adds opponent bots, advances time, fires
queued events, and triggers settlement. Returns trades, fills the
strategy was party to, final PnL/positions/cash, and final status.

Use `seed` for reproducibility — identical inputs produce identical
outputs.

## Authoring checklist for a new strategy

1. Create `server/bots/strategies/<my-id>.ts`. Export `default` of
   type `BotStrategy<P>`. `P` is a type alias of `Readonly<{...}>`,
   not an interface.
2. Declare `paramsSchema` and read `ctx.params` inside handlers.
3. Compose from `helpers/` instead of reaching into engine internals.
4. Add the strategy to `server/bots/registry.ts`. The key must equal
   the strategy's `id` and the filename. `validateRegistry()` will
   throw at module load if not.
5. Add tests under `tests/`. Use `runHeadless()`; assert on `trades`,
   `fillsForMe`, `finalPnl`. Keep `seed` fixed for reproducibility.

## Engine integration seam

The orchestrator hooks into `MockerySession` via `setHooks(...)`:

| `SessionHooks` event | What the orchestrator dispatches |
| --- | --- |
| `onEnterPlaying` | Instantiate every bound bot, validate its params, fire `onStart` on each. |
| `onTrades(trades)` | Fan out `onTrade` to every instance; additionally fire `onMyFill` once per fill the instance was party to. |
| `onEvent(event)` | Fan out `onEvent`. |
| `onMarketChanged` | Refresh contexts. Fire `onMarketData`. For each contract whose top-of-book fingerprint changed, fire `onBookUpdate`. If `phase` advanced, fire `onPhaseChange`. |
| `onGameOver` | Fire `onGameOver` with `GameResult`, cancel all timers, clear instances. |

Re-entrancy: when a strategy's action triggers another state change
mid-callback, the orchestrator defers the dispatch and re-runs the
loop. Depth is capped at 8 to prevent runaway recursion; throws are
counted and the offending instance is quarantined after 5.

## Known limits / future work

These are deliberately *not* part of the current refactor — flagged
so they don't get forgotten:

1. **Auto-discovery registry.** `registry.ts` is still hand-curated.
   `import.meta.glob` is Vite-only and `bots/` is server-side, so
   auto-discovery would need a Node fs scan at module init with
   async dynamic imports. Worth doing once the catalogue exceeds
   ~6 strategies; for now `validateRegistry()` catches typos.
2. **Per-tick snapshot sharing.** `buildSnapshotFor(entityId)` rebuilds
   for every instance on every callback. The bookkeeping is the same
   across instances; once we have ≥5 bots in a typical session, cache
   the snapshot keyed by `(engineVersion, entityId)`.
3. **Rate limiting + structured logging.** A runaway author can issue
   actions in a tight loop; the engine accepts them all. A
   token-bucket on the orchestrator plus a `ctx.log(level, msg)` that
   the harness can assert on would close both gaps. The
   `console.warn` at `runtime.ts:255` should route through the same
   channel when this lands.
4. **Self-trade detection on `onTrade`.** Today, `onMyFill` is fired
   in addition to `onTrade` when the bot is party. We could
   alternatively suppress `onTrade` for self-fills; left split so
   authors who want tape-reading still see them.

## File-level invariants worth preserving

- Strategy files never import from `engine/`, `server/`, or other
  strategies. Only `../api`, `../helpers`, and pure stdlib.
- `BotStrategy.id` matches the filename and matches the registry key.
- `MarketSnapshot.displayName` for bots is always `null` — bots see
  the redacted projection like any other player.
- `ctx.params` is frozen and matches the strategy's `paramsSchema`.
- Timers created via `ctx.setTimer` are always cancelled at game over;
  the orchestrator walks the per-instance handle set as a safety net.
- A throwing strategy is sandboxed: its errors don't escape
  `dispatchTo`, they bump `errorCount`, and 5 throws → quarantine.
