# Bot spawning model

How a single bot player runs many concurrent, parametrically-drawn,
stochastically-spawned strategy instances under one or more participant
codes. Pairs with `bot-author-guide.md` (the per-strategy contract) and
`bot-modularity.md` (the orchestrator architecture).

> **Status:** v0.2 — nomenclature and parameter-distribution surface
> landed; multi-instance orchestrator, multi-code routing, and the
> first strategy (`natural-player`) are next.

---

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **Strategy** | The algorithmic template (e.g. `natural-player`, `market-maker`). One file per strategy in `server/bots/strategies/`. Carries a `paramsSchema` declaring the parameters it accepts. |
| **Profile** | A strategy bound to a concrete parameter draw plus spawn metadata (Poisson rate, lag, scope). One strategy can have many profiles in the same game — e.g. seven `natural-player` profiles all with different sizes, urgencies, and spawn rates. |
| **Instance** | A live activation of a profile. Permanent profiles instantiate once at game start; spawning profiles arrive over time per a Poisson process. Multiple instances of the same profile can be alive concurrently. |
| **Bot** | The configured player. Owns ≥ 1 profiles across ≥ 1 participant codes. Orders placed by any of its instances are routed through one of its codes (uniformly, by default). |

Strategy authors write a `BotStrategy` (see `bot-author-guide.md`).
Everything in this document is one layer above that — how the
orchestrator turns a `BotConfig` into many concurrent strategy
instances.

## 2. Spawn lifecycle

A profile is either **permanent** (one instance from game start to
game end) or **spawning** (instances arrive over time per a Poisson
process with rate λ samples/second, and each instance lives until the
strategy closes itself or the game ends).

```
game-start ──▶  draw N profiles per ProfileSpec (hyperparameter)
            ──▶  for each profile:
                   if permanent: instantiate now
                   if spawning : schedule first arrival at Exp(λ)
                                 on each arrival: instantiate + reschedule

instance ───▶  runs until strategy calls ctx.close() or game ends
```

The orchestrator does not deduplicate concurrent instances of the same
profile — two natural-buyers of size 10 can be filling simultaneously.
The bot's *aggregate* position is the sum across instances and codes.

## 3. Position scopes

Some strategies care about their **own** position (e.g. "stop buying
once *this instance* has filled its target"); others care about the
**shared** bot-level position (e.g. "if the bot is already long 100,
don't add"). Each profile picks one:

| `scope` | Tracks |
|---|---|
| `"instance"` | This instance's fills only — local bookkeeping kept in `ctx.local`. |
| `"shared"` | The bot entity's position across every instance, code, and profile. |

`ctx.myPosition()` returns the engine-level position for the entity
(equivalent to `shared`). Instance-local position is the strategy
author's responsibility, computed from the instance's own fills via
`onMyFill`.

## 4. Parameter distributions

Every numeric parameter — `spawnRate`, `lag`, strategy params, and the
profile-count hyperparameter — is declared as a `Distribution` rather
than a hard number. The orchestrator draws values at game-setup time
using the engine's seeded RNG, so replays reproduce identical bots.

```ts
type Distribution =
  | { kind: "constant";        value: number }
  | { kind: "uniform";         min: number; max: number }                                  // [min, max)
  | { kind: "uniform-int";     min: number; max: number }                                  // [min, max] inclusive
  | { kind: "gaussian";        mean: number; std: number; min?: number; max?: number }     // clamped
  | { kind: "gaussian-int";    mean: number; std: number; min?: number; max?: number }
  | { kind: "exponential";     rate: number;             min?: number; max?: number }
  | { kind: "exponential-int"; rate: number;             min?: number; max?: number }
  | { kind: "categorical";     choices: readonly { value: number; weight: number }[] };
```

`min`/`max` clamp the draw, so e.g. `gaussian { mean: 5, std: 2, min: 1 }`
will never go below 1. Integer variants round after clamping.

See `engine/sampling.ts` for the sampler and `tests/sampling.test.ts`
for the property tests.

## 5. Bot configuration shape

Per-spec parametric input (host writes this):

```ts
interface BotConfigSpec {
  readonly strategies: readonly StrategySpec[];
}

interface StrategySpec {
  readonly strategy: BotStrategy;                     // the inner template
  readonly count: Distribution;                       // hyperparameter
  readonly spawn:
    | { mode: "permanent" }
    | { mode: "poisson"; ratePerSec: Distribution };
  readonly lagMs: Distribution;
  readonly scope: "instance" | "shared";
  readonly params: Readonly<Record<string, Distribution>>;
}
```

At setup, `drawProfiles(spec, rng)` (in `server/bots/config.ts`) reads
the spec and the engine's seeded RNG and returns `Profile[]` ready for
`multiProfileBot`. For each `StrategySpec`:

1. Draw `count` (rounded to a non-negative int) from `spec.count`.
2. For each of those profiles, independently draw `spawn.ratePerSec`,
   `lagMs`, and every `params[*]`. Profile IDs are `<strategy.id>#<n>`.

Same seed → same draws → identical replays.

Multi-code routing (engine-level) lives on a `BotConfig` wrapper that
will be wired later — see §6 / §8.

## 6. Multi-code routing

A bot can own multiple codes — `codes: ["AB", "CD", "EF"]` — and each
order is placed under a code sampled per `routing`. This makes the
bot's behavior harder to fingerprint (no single code shows the full
pattern).

**Implementation status: deferred.** Currently `1 entity = 1 code`
(see `server/MockerySession.ts` `onSetupSetBotEntities`). The engine
keys positions, cash, and codes by `participantKey({ kind: "bot",
entityId })`, so extending to many codes per entity needs:

- Engine: allow a bot entity to register a code set; route orders by
  the code field rather than synthesising from `entityId`.
- Orchestrator: at `actionPlace`, sample a code from the bot's set and
  pass it in the intent.
- Snapshot: the bot sees its aggregate position across its codes.

## 7. Per-strategy docs are the source of truth

Every strategy has its own file in `docs/bots/<strategy>.md` describing:

- Behavior (what it does, in prose).
- Parameters table — name, units, what it means, sane bounds.
- Termination condition.

The strategy's `paramsSchema` in TypeScript must mirror the doc. They
drift, that's a bug; CI can later assert they match.

To edit a strategy's behavior, edit its doc and its TypeScript file in
the same change. If the parameter set changes, the `ProfileSpec`s in
test fixtures and any saved games will need migration.

## 8. Status and next steps

| Layer | Status |
|---|---|
| Nomenclature (this doc) | landed |
| Parameter distribution sampler (`engine/sampling.ts`) | landed |
| Market helpers — `marketWidth`, `isMarketSafe`, `secondsSinceLastAction` | landed |
| Historical-stats helpers — `TimeSeries`, reducers | landed |
| `natural-player` spec doc + v1 implementation | landed |
| Multi-instance spawner (`server/bots/spawning.ts`) | landed |
| `BotContext.setTimer` callback receives fresh ctx | landed |
| Per-instance fill attribution (`Trade.restingOrderId`) | landed |
| `drawProfiles(BotConfigSpec, rng)` programmatic API | landed |
| Wire-format `WireBotConfigSpec` + `resolveWireSpec`/`drawProfilesFromWire` | landed |
| Multi-code routing (engine + orchestrator) | **next** |
| Session integration: `SETUP_SET_BOT_CONFIG` + auto-spawner-build | next |
