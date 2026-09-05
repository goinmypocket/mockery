# Mockery — engine spec

A real-time, asymmetric-information trading game. Some players hold
private cards and trade against players who don't. The cards drive the
settlement of a set of contracts at game end; periodic events reshape
which cards are private vs public. Bots also trade — but the engine
treats them as ordinary participants.

This document is the engine authority. UI lives in
`game-ui-spec.md`.

> **Status:** v0.4 spec. Open questions in §13.

---

## 1. Glossary and named parameters

The prompt used short names (c, p, k, x, y, m, R). This spec uses the
following meaningful names instead, and they're authoritative for code
and docs going forward.

| New name | Old | Meaning |
|---|---|---|
| `cardValues` | (extends `c`) | The set of distinct face values used in the deck, e.g. `[1, 2, 9, 10]`. |
| `copiesPerValue` | `p` | How many copies of each value the deck contains. |
| `deckSize` | `N` | Derived: `cardValues.length × copiesPerValue`. |
| `informedSeats` | `x` | Number of seats whose occupant holds one private card. |
| `uninformedSeats` | `y` | Number of seats whose occupant holds no card. |
| `playerCount` | `k` | Derived: `informedSeats + uninformedSeats`. |
| `publicSlots` | `m` | Number of public cards (initially face-down). |
| `cardsInPlay` | (= `x + m`) | Derived: `informedSeats + publicSlots`. The total cards drawn from the deck for this game. |
| `contracts` | (extends `R`) | The list of `ContractDef` objects tradable in this game. |

Other vocabulary:

- **Card** — one physical card with a face value. The deck has
  `deckSize` cards.
- **Player** — a human at a seat. There are `playerCount` of them.
- **Bot** — an automated trader. From the engine's perspective bots
  are participants indistinguishable from players (§7). Bots are
  always uninformed.
- **Participant** — either a player (identified by `userId` and
  `seatIndex`) or a bot (identified by a `botEntityId`). All trading,
  positions, and PnL are keyed on participants.
- **Contract** — a tradable instrument with a settlement function
  that maps the final card tuple to a numeric payoff.
- **Phase** — a stable interval of game time between two consecutive
  events. The game starts in phase 0; every event increments the
  phase. Phase identity colours TNS rows and labels trades.
- **Host** — the platform-assigned table host. May be informed,
  uninformed, or a spectator. Has elevated privileges (§6, §9).

## 2. Configuration

Game options selected at table creation time. Defaults reflect the
chosen first scenario.

| Key | Type | Default | Notes |
|---|---|---|---|
| `cardValues` | `number[]` | `[1, 2, 9, 10]` | Distinct face values |
| `copiesPerValue` | `integer ≥ 1` | `4` | Copies of each value |
| `informedSeats` | `integer ≥ 1` | `6` | Players who get a private card |
| `uninformedSeats` | `integer ≥ 0` | `0` | Players who don't |
| `publicSlots` | `integer ≥ 0` | `3` | Initially-hidden public cards |
| `eventMode` | enum | `auto` | `"auto"` (timer fires events) or `"manual"` (host fires events). See §6. |
| `eventIntervalMin` | `integer (sec)` | `300` | Auto mode only. Minimum gap between events (5 min). |
| `eventIntervalMax` | `integer (sec)` | `480` | Auto mode only. Maximum gap (8 min). |
| `endGameGraceSec` | `integer (sec)` | `0` (auto: same as `eventIntervalMin..Max`) | Manual mode only. Optional countdown the host can start when ready to wrap up; `0` means end-of-game requires an explicit host click. |
| `seed` | `integer` | `0` (= pick fresh) | Deterministic deal & sampling |
| `contractsRef` | string-or-inline | (none) | References into the shared/user libraries plus inline overrides — see §5.4 |
| `codeMode` | enum | `alpha` | `"alpha"` (codes derived from display names) or `"random"` (random 2-letter codes drawn from the seed). See §11. |
| `enforceCaseByRole` | boolean | `false` | If `true`, codes are uppercase for informed participants and lowercase for uninformed. Otherwise the host's entries are used verbatim. |
| `identityReveal` | enum | `all` | Who sees the code↔display-name mapping: `"all"` everyone, `"host"` only the host, `"listed"` a configured list of viewer userIds. See §11. |
| `identityRevealList` | UserId[] | `[]` | Used when `identityReveal === "listed"`. |

Constraints:

- `cardsInPlay ≤ deckSize`
- `informedSeats + uninformedSeats ≥ 2`
- `eventIntervalMin ≤ eventIntervalMax` (auto mode)
- Each `cardValues[i]` is a unique integer.

`playerCount = informedSeats + uninformedSeats` is what the platform
sees as the seat count. Bots are not seats. Spectators are allowed.

## 3. Setup and game phases

The session moves through these phases:

```
lobby (platform-owned)
  └─ all seats filled, host hits Start
setup (Mockery-owned)
  └─ host configures contracts and the event queue, then hits Start Trading
playing
  └─ market open. In auto mode events fire on a timer; in manual mode the
     host fires them by clicking. Both modes use the host's event queue.
finished
  └─ settled
```

`session.describe().status` reports `lobby` only during platform
lobby; `setup` and `playing` both report as `playing` to the platform
because Mockery owns everything past lobby.

### 3.1 Setup phase

Activated when the host starts the game from the platform lobby.
Inside the setup phase:

- The host edits the **contracts list** (§5).
- The host edits the **event queue** (§6.1).
- Other participants see a read-only preview of contracts and the
  event queue and a "Waiting for host" banner.
- The host hits **Start Trading** to enter `playing`. Mockery rejects
  Start Trading if any of: contracts list empty, event queue empty,
  any contract has a malformed `payoff` source.

### 3.2 Playing phase setup

When entering `playing`:

1. Build the deck: for each value in `cardValues`, append
   `copiesPerValue` cards.
2. Seed the RNG and shuffle.
3. Deal one card face-down to each informed seat.
4. Deal `publicSlots` cards face-down into `public[0..publicSlots-1]`.
5. Initialise an empty order book per contract.
6. If `eventMode === "auto"`, initialise the event timer with a
   uniform draw from `[eventIntervalMin, eventIntervalMax]` (RNG).
   If `eventMode === "manual"`, no timer is armed — events wait for
   the host's click.
7. Set `phase = 0`. Begin ticking.

## 4. Order book and matching

### 4.1 Order intents

Both intents carry `(contractId, side, qty, price)` with `side ∈
{buy, sell}`, `qty` a positive integer, and `price` an integer
(currency units, no fractions; integer prices keep matching
deterministic and avoid float drift).

- **`PLACE_LIMIT`** — adds a resting order to the book. If the order
  crosses the opposite top-of-book it executes against the standing
  book at the standing book's prices, FIFO across price levels. Any
  unfilled residual rests at the limit price.
- **`PLACE_IOC`** — same matching, residual is cancelled rather than
  posted. The Order Book module's "hit/lift" buttons emit this with
  `price = best opposing price` and `qty` from the textbox. The
  Order Placer module emits whichever the user picked.

### 4.2 Matching rules

- Price/time priority. Standing orders are kept in time-priority FIFO
  within each price level.
- Aggressor pays the standing price. Trade prints carry an
  `aggressor` flag identifying the taker.
- A `PLACE_LIMIT` whose limit is more aggressive than the opposing
  best continues to consume liquidity FIFO until either (a) qty is
  exhausted, (b) the next opposing level is worse than the limit, or
  (c) the book is empty on that side.
- Self-trade prevention: an order that would match against the same
  participant's resting order on the opposing side instead cancels
  that resting order first, then continues. Two distinct
  participants — even if they happen to be controlled by the same
  bot orchestrator — can cross each other freely; the engine has no
  notion of "who really submitted this".

### 4.3 Cancellation

- **`CANCEL_ORDER(orderId)`** — owner only. Removes a resting order.
- No amend in v0.1; clients should cancel and re-place.

### 4.4 Short selling

Allowed without margin. A participant's position in a contract is
signed (positive long, negative short). No cap on absolute size in
v0.1.

### 4.5 Trade record

Every fill produces a `Trade`:

```ts
interface Trade {
  id: TradeId;
  ts: number;            // server ms
  phase: number;
  contractId: ContractId;
  buyer: ParticipantId;
  seller: ParticipantId;
  price: number;
  qty: number;
  aggressor: "buyer" | "seller";
}
```

`ParticipantId = { kind: "player", userId } | { kind: "bot", entityId }`.

## 5. Contracts and settlement

### 5.1 Contract definitions

```ts
interface ContractDef {
  id: ContractId;
  name: string;          // "≥3 sevens"
  description: string;   // user-facing
  payoffSource: string;  // free-form JS source — see §5.2
  payoffHash: string;    // sha256 of payoffSource, recorded with the table
}
```

Contracts are pinned to the table at the moment the host hits Start
Trading. Editing a saved contract in the user's library afterwards
does not change the running game.

### 5.2 Free-form JS payoffs

A `payoffSource` is the body of a pure JS function with this
signature:

```js
// receives cards: an array of integers, the final card tuple
// (informed seats in seat order, then public slots in slot order)
// returns a number — the contract's settlement value.
function payoff(cards) {
  // user code
}
```

The host writes the body of `payoff`. At evaluation time the engine
runs it in a server-side **sandboxed VM** (Node `vm.Script` or an
isolated-vm equivalent) with:

- no access to globals (`require`, `process`, `fetch`, `setTimeout`,
  etc. all unavailable);
- a small helper namespace exposed as `H`:
  - `H.count(cards, pred)` — number of cards satisfying `pred`
  - `H.sum(cards)` — sum
  - `H.sumWhere(cards, pred)` — sum over the cards satisfying `pred`
  - `H.where(cards, pred)` — filtered array
  - `H.max(cards)`, `H.min(cards)`
  - `H.unique(cards)` — count of distinct values
  - `H.has(cards, value)` — boolean
  - `H.PUBLIC_START` — index where the public-card slice begins
    (= `informedSeats`); use `cards.slice(H.PUBLIC_START)` for
    public-only logic.
- a wall-clock timeout (e.g. 50 ms) and a memory cap;
- cards is passed as a frozen array.

If `payoff` throws or times out, the contract settles to `0` and the
session emits a `CONTRACT_SETTLE_ERROR` system message visible in the
TNS pane.

### 5.3 Validation

When the host adds or edits a contract in the setup phase, the engine:

1. Statically scans the source for forbidden tokens (a denylist:
   `require`, `import`, `eval`, `Function`, `process`, `globalThis`,
   `__proto__`, `constructor`). Contracts that contain these are
   rejected with a clear error.
2. Compiles the source in the sandbox.
3. Runs `payoff` against a small fuzz sample of card tuples to make
   sure it returns a finite number.

The static denylist is a defence-in-depth check; the sandbox is the
real boundary.

### 5.4 Contract libraries

There are two libraries the host's contract picker pulls from at
setup, plus the table-pinned copy that ends up in the save:

1. **Shared library** (`mockery/config/shared-contracts.json`).
   Ships with the Mockery module, version-controlled with the repo,
   evolves during development. Read-only at runtime — users can't
   edit shared entries through the UI, only copy-and-edit them into
   their personal library or directly into the table. New shared
   contracts are added via PRs to the Mockery repo.

2. **User library** — per-user CRUD storage backed by a SQLite
   table inside the platform's database, owned by the Mockery
   server module:

   ```
   mockery_user_contract_library
     user_id, name, description, payoff_source, created_at, updated_at
   ```

   Each user has their own private library. CRUD endpoints are
   exposed by Mockery's server module and called from the host's
   client during setup.

3. **Table-pinned** — when the host hits Start Trading, the
   contracts referenced from either library plus any inlined
   one-offs are deep-copied into the table state (`contracts` array
   in §5.1). Subsequent edits to either library do **not** affect a
   running game.

The host's setup UI shows both libraries side-by-side with a
"shared" badge on shared entries.

### 5.5 Default starter contracts (shared library)

`config/shared-contracts.json` ships with these three to start. More
will be added during development.

```js
// 1. "Sum of all cards"
function payoff(cards) {
  return H.sum(cards);
}

// 2. "10 × number of even cards"
function payoff(cards) {
  return 10 * H.count(cards, c => c % 2 === 0);
}

// 3. "Sum of evens minus sum of odds"
function payoff(cards) {
  return H.sumWhere(cards, c => c % 2 === 0)
       - H.sumWhere(cards, c => c % 2 === 1);
}
```

## 6. Events and the host queue

### 6.1 Event queue

The host maintains an ordered **event queue** during setup and
during play. Each entry is one of:

- **`ROTATE_INFORMED`** — every informed player passes their card to
  the informed player to their right (seat-order, skipping
  uninformed seats). Removed from the queue when fired.
- **`REVEAL_PUBLIC { slotIndex? }`** — reveals one public card. If
  `slotIndex` is omitted, the engine picks the lowest-indexed
  still-hidden slot. If specified, must reference a hidden slot.

The queue may contain any mix and any order. It must be non-empty
before Start Trading.

### 6.2 Firing events

When an event fires, regardless of mode, the engine:

1. Pops the head of the queue.
2. Applies it (rotate or reveal).
3. Increments `phase`.
4. Broadcasts `EVENT { type, payload }` to all clients.

What differs per mode is **what triggers the firing**.

#### 6.2a Auto mode (`eventMode === "auto"`)

When `playing` begins, the engine draws a delay
`d ∈ [eventIntervalMin, eventIntervalMax]` and arms a timer. When
the timer fires, step 1–4 above run, then the engine draws a fresh
delay and re-arms.

When the queue is empty, the engine instead schedules
**end-of-game settlement** one more interval ahead and broadcasts
`EVENT_QUEUE_EMPTY`. When that final timer fires, the engine
reveals any still-hidden public cards, evaluates payoffs, and
transitions to `finished`. (Per the prompt: "the game ends after
the interval after the last event.")

#### 6.2b Manual mode (`eventMode === "manual"`)

No timer is armed. The host fires events explicitly via
**`FIRE_NEXT_EVENT`**. End-of-game requires an explicit host
**`END_GAME`** (gated on the queue being empty, unless the host
also chooses to abandon — see §6.3).

The host MAY arm an optional grace timer
(`endGameGraceSec`) as a courtesy countdown after the queue
empties — useful for "1 minute warning, then settle". Setting
`endGameGraceSec === 0` disables it; the host must click `END_GAME`
explicitly.

### 6.3 Host controls during play

Mode-agnostic queue ops (any time during `playing`):

- **`QUEUE_APPEND(event)`** — push to the back.
- **`QUEUE_INSERT(idx, event)`** — insert at index.
- **`QUEUE_REMOVE(idx)`** — remove the event at index.
- **`QUEUE_MOVE(from, to)`** — reorder.

Auto-mode-only:

- **`DELAY_NEXT_EVENT(seconds)`** — adds `seconds` to the
  next-event timer; clamped so the event cannot fire less than 1 s
  from now.
- **`PREPONE_NEXT_EVENT()`** — fires the next event immediately
  (functionally identical to manual mode's `FIRE_NEXT_EVENT`, but
  exists in auto mode for the case "I want this one early without
  switching modes").

Manual-mode-only:

- **`FIRE_NEXT_EVENT()`** — fires the head of the queue now.
  Rejected if the queue is empty.
- **`END_GAME()`** — settles immediately. Rejected if the queue is
  not empty (the host has to clear or remove pending events first;
  this is a deliberate guard against accidental settlement).
- **`START_GRACE_TIMER(seconds)`** — arms a one-shot grace timer.
  When it fires the engine settles. The host can cancel it with
  **`CANCEL_GRACE_TIMER`** before it fires.

Host actions are recorded in TNS as system rows.

### 6.4 Phase numbering

`phase` increments on every event firing (rotate or reveal). The
"queue empty, waiting for end" state is the same phase as the last
event — settlement does not bump phase.

### 6.5 Visibility

The full event queue (types, target slot indices, ordering) is
**public to all participants**. Players and bots can see what's
coming, just not what cards will be exposed by upcoming reveals
(values are still hidden until the reveal fires).

## 7. Bots

The engine treats bots as ordinary participants. From the engine's
perspective:

- A bot has a `botEntityId` (a stable string brand, e.g. `"ABC"`).
- A bot is uninformed: it never sees private cards or unrevealed
  public cards.
- A bot submits the same intents as players (PLACE_LIMIT, PLACE_IOC,
  CANCEL_ORDER) under its `ParticipantId = { kind: "bot",
  entityId }`.
- Positions, PnL, and trade prints work identically.

**Bots run server-side**, inside the Mockery server module. The
session exposes an internal API:

```ts
interface BotSeat {
  entityId: string;
  // server-side bot loop registers a callback that the engine calls
  // on every market data event so the bot can react.
  onMarketData(handler: (md: MarketSnapshot) => void): void;
  submit(intent: PlayerIntent): Result;
}
```

The Mockery module's bot orchestrator code (separate from the engine
itself) is what actually runs bot strategies. From the engine's
viewpoint a bot is just another `ParticipantId` whose intents arrive
through `submitBotIntent` instead of `handleGameMessage`.

### 7.1 Multiple bots per entity, multiple entities per bot

These are concerns of the **bot orchestrator**, not the engine. The
orchestrator decides which bot strategy code submits intents under
which entity. The engine sees only the entity tag on each intent.
PnL by-bot, if needed at all, is tracked inside the orchestrator's
private bookkeeping, not the engine's save.

This means, importantly:

- Multiple bots colluding under one entity look like one trader to
  the engine.
- One bot trading two entities looks like two independent traders to
  the engine.
- Self-trade prevention applies at the participant level — a bot
  cannot cross with itself under the same entity, but two distinct
  entities operated by the same bot CAN cross.

### 7.2 Configuration

At setup, the host configures the list of bot entities (just names)
and which of them are active for this game. The bot orchestrator's
strategy code is registered server-side and not chosen per game in
v0.1.

## 8. PnL during the game

For each contract `i` and participant `p`:

- `pos_i = sum of signed fills`
- `cash_i = sum of (−price × qty) for buys, (+price × qty) for sells`
- `mark_i = mid_i if both sides quoted, else lastTradePrice_i, else 0`
- `mtm_i = pos_i × mark_i + cash_i`

Total PnL = `Σ_i mtm_i`. Update on every order book change and every
trade.

At game end, replace `mark_i` with `settle_i` (the contract's
settlement value, evaluated against the final card tuple) and emit
the final per-participant PnL.

## 9. Game end

End-of-game trigger depends on `eventMode`:

- **Auto mode**: per §6.2a. When the queue empties, the engine
  arms one final timer drawn from
  `[eventIntervalMin, eventIntervalMax]`; on fire, the engine
  settles.
- **Manual mode**: per §6.2b. The host explicitly calls `END_GAME`
  (only valid when the queue is empty), or arms a grace timer that
  fires settlement on expiry.

Settlement steps (identical for both modes):

1. Reveal any still-hidden public cards (so the card tuple is
   complete and visible to everyone).
2. For each contract, run its `payoff` in the sandbox against the
   final card tuple. Errors → settle to 0 (with a system message).
3. Compute final per-participant PnL.
4. Broadcast `GAME_OVER { cards, settlements, finalPnl }`.
5. Transition to `finished`.

## 10. Platform integration

### 10.1 GameDefinition

```ts
{
  id: "mockery",
  displayName: "Mockery",
  minPlayers: derived from informedSeats + uninformedSeats,
  maxPlayers: same,
  supportsSpectators: true,
  optionsSchema: ...as §2,
  createSession, loadSession, normalizeOptions
}
```

`minPlayers === maxPlayers` because Mockery requires exactly
`playerCount` seats.

### 10.2 Player → server intents

- `PLACE_LIMIT { contractId, side, qty, price }`
- `PLACE_IOC { contractId, side, qty, price }`
- `CANCEL_ORDER { orderId }`

Setup-phase intents (host only, status === setup):

- `SETUP_ADD_CONTRACT { name, description, payoffSource }`
- `SETUP_REMOVE_CONTRACT { contractId }`
- `SETUP_REPLACE_CONTRACT { contractId, name, description, payoffSource }`
- `SETUP_IMPORT_CONTRACT { source: "shared" | "user", refId }` — copy a
  library contract into the table.
- `SETUP_SET_BOT_ENTITIES { entityIds }`
- `SETUP_BIND_BOT_STRATEGY { entityId, strategyId | null }`
- `SETUP_SET_EVENT_MODE { mode: "auto" | "manual" }`
- `SETUP_SET_CODE { participantKey, code }` — set / override one
  participant's code (§11)
- `SETUP_RESHUFFLE_CODES` — regenerate the code book (respects
  `codeMode` and `enforceCaseByRole`)
- `SETUP_SET_IDENTITY_REVEAL { mode, list? }` — change who sees
  the code↔name mapping
- `SETUP_QUEUE_*` — same shape as §6.3 queue ops
- `START_TRADING`

Play-phase host intents (host only, status === playing):

- `QUEUE_APPEND`, `QUEUE_INSERT`, `QUEUE_REMOVE`, `QUEUE_MOVE`
- Auto mode: `DELAY_NEXT_EVENT`, `PREPONE_NEXT_EVENT`
- Manual mode: `FIRE_NEXT_EVENT`, `END_GAME`,
  `START_GRACE_TIMER { seconds }`, `CANCEL_GRACE_TIMER`

Per-user library intents (any time, not table-scoped):

- `LIBRARY_LIST`
- `LIBRARY_SAVE { name, description, payoffSource }`
- `LIBRARY_UPDATE { id, name, description, payoffSource }`
- `LIBRARY_DELETE { id }`

Bot intents are the same as player order intents but reach the
engine through the in-process bot API (§7), not the WebSocket.

### 10.3 Server → client (projected per recipient)

- `STATE_SNAPSHOT` — full snapshot at attach. Includes book tops,
  recent TNS (last N), positions, PnL, your own private card if
  informed, public-card array with face values for revealed slots
  and `null` for hidden, current phase, ms-until-next-event, the
  current contract list (definitions, not source — see redaction),
  the visible event queue, list of bot entities, list of player
  seats, host id.
- `BOOK_DELTA` — incremental book changes per contract.
- `TRADE` — one new fill (TNS row).
- `EVENT` — `{type:"ROTATED"}` or `{type:"REVEALED", slotIndex,
  value}`.
- `EVENT_TIMER { mode, msRemaining }` — periodic tick (~1 Hz). In
  auto mode `msRemaining` is the countdown to the next event. In
  manual mode `mode === "manual"` and `msRemaining` is the grace
  timer's remaining ms (or `null` if not armed).
- `POSITION_UPDATE`, `PNL_UPDATE` — per-participant deltas.
- `INTENT_REJECTED { intent, reason }` — standard platform feedback.
- `SETUP_UPDATE` — sent to all during setup whenever the host edits
  contracts, queue, or bot entities.
- `GAME_OVER` — final settlements + PnL.

### 10.4 Redaction rules

- **Informed player**: sees their own private card. Sees nobody else's
  private card. Sees revealed public cards. Sees positions, PnL,
  book, TNS, all events. Identifies all other participants by
  code (per §11).
- **Uninformed player / spectator / bot**: same minus their own card
  (they don't have one).
- **Contract source code**: visible to all participants, since the
  whole point is everyone trades knowing what they're trading.
- **Hidden card values**: must not appear in any payload sent to a
  client. Server-enforced.
- **Identity reveal (`code → display name` mapping)**: redacted
  per `identityReveal` (§11). The participant always sees their
  own link.
- **Real userIds and entityIds**: redacted from public projection.
  Trades, books, and positions are projected with `code` strings
  only. Internal `participantKey` strings (`p:<userId>`,
  `b:<entityId>`) never reach clients.

### 10.5 Persistence

Save shape (`Save = MockerySave`):

```ts
interface MockerySave {
  version: 1;
  options: ResolvedOptions;
  status: "setup" | "playing" | "finished";
  rngState: ...;
  cards: {
    informed: Record<UserId, CardValue>;
    public: (CardValue | null)[];   // values, even for hidden — redaction is a projection-time concern
  };
  phase: number;
  msSinceStart: number;
  msUntilNextEvent: number;
  eventQueue: EventQueueEntry[];
  contracts: ContractDef[];          // with payoffSource captured at lock-in
  books: Record<ContractId, BookSnapshot>;
  trades: Trade[];                   // full history
  positions: Record<ParticipantIdKey, Record<ContractId, number>>;
  cash: Record<ParticipantIdKey, number>;
  botEntities: { entityId: string }[];
  hostUserId: UserId;
}
```

The save is opaque to the platform.

## 11. Participant codes and anonymization

Every participant is shown to other participants under a **2-letter
code**, not their display name. Codes are the public identity in
trade prints, order-book parties, position rows, etc.

### 11.1 Code rules

- A code is exactly 2 ASCII letters (`[A-Za-z]{2}`).
- Codes are **case-insensitive** for uniqueness: `AB` and `ab`
  collide; setup rejects collisions.
- Codes are **case-significant** for display when
  `enforceCaseByRole === true`: uppercase = informed, lowercase =
  uninformed. The engine forces case at lock-in to match the role.
- When `enforceCaseByRole === false`, the host can use any case mix.

### 11.2 Code book

`codeBook` is a map `participantKey → code` (engine spec §1).
It is generated when the host enters `setup`, editable during
`setup`, and frozen at Start Trading.

Generation defaults:

- `codeMode === "alpha"` — codes derive from display names. For a
  player, default = first two letters of the platform display name
  (a-z stripped of non-alpha characters, padded with `X` if shorter
  than 2). For a bot, the entityId is **required** to be exactly
  two letters and is used verbatim. Collisions are resolved by
  advancing to the next unused pair (`AB → AC → AD …`, wrapping
  `ZZ → AA`). This also applies to players with matching names or
  initials, so automatic guest names never block starting a table.
  Assigned codes remain visible and editable in setup; manually entered
  collisions are still rejected. Existing saved code books are unchanged.
- `codeMode === "random"` — codes are drawn from the alphabet via
  the seeded RNG. Each participant gets a unique pair. With
  `enforceCaseByRole === true`, the case follows role; otherwise
  the engine produces uppercase codes by default.

The host can override any individual code in setup
(`SETUP_SET_CODE { participantKey, code }`). Each override is
re-validated for case-by-role and uniqueness.

### 11.3 Identity reveal

The `code → display name` mapping is itself a redactable payload.
Who sees it depends on `identityReveal`:

- `"all"` — everyone sees the full mapping (codes are still shown,
  but any viewer can see "AB = Alice").
- `"host"` — only the table host sees the mapping.
- `"listed"` — only viewers in `identityRevealList` see the
  mapping. Others see only codes; their own entry is always
  revealed to them.

Trades, books, and positions are projected with codes regardless
of mode — the asymmetry is purely about whether `code → name`
links are sent.

A participant always sees their own code↔name link, no matter the
mode. Bots have no display name beyond their entityId, which is
already 2 letters; for them the "name" is identical to the code.

### 11.4 Worked example

A 6-player game, mode `tokens` (i.e. `"random"` + `"host"`):

- Engine generates `AB, CD, EF, GH, IJ, KL` for the six players.
- All viewers see trade prints like `AB buys 5 @ 42 from CD`.
- Only the host knows that `AB = Alice, CD = Bob, ...`.
- Each player knows their own code.

A spectator-blind variant uses mode `listed` with the host plus
the players themselves on the list — players see each other's
real names, but visiting spectators see only codes.

## 12. Determinism and clock

- All randomness flows from a single seeded RNG. Event delays, deal
  order, etc. all draw from it.
- Event timing uses the **server wall clock** for "next-event-at",
  but the *interval* is drawn deterministically from the seed. On
  load, the session restores the remaining ms from the save.
- Clients never drive the timer; the server emits `EVENT_TIMER`
  ticks (~1 Hz) for display only.

## 13. Security: payoff sandbox

- All `payoff` execution happens in a sandboxed VM with no network,
  filesystem, or process access.
- Static denylist (§5.3) catches obvious escapes before compilation.
- Wall-clock timeout per call (default 50 ms) prevents loops from
  stalling settlement.
- Memory cap (default a few MB) prevents allocation bombs.
- A failing or timed-out `payoff` settles its contract to 0 and
  emits a system message; it does not crash the session.

## 14. Open questions

1. **Bot strategy registration.** Strategies are server-side code in
   `mockery/server/bots/strategies/`, each file exporting a
   `BotStrategy` and registered in `registry.ts`. Adding a strategy
   = adding a file + entry. The host wires entity → strategy in
   setup. Confirm this directory layout — see also
   `bot-author-guide.md`.
2. **Setup-phase vs lobby.** Mockery introduces a `setup` phase
   between platform-lobby and `playing`. The platform sees both
   `setup` and `playing` as "playing" (game-side state). Confirm
   that's acceptable or if we should push some of setup back into
   table-creation options.
3. **Bot entity uniqueness.** Bot entity ids are bare strings
   (`"ABC"`). v0.1 assumes per-table-unique only. OK?
4. **Tick size.** Integer prices, default tick 1. Reasonable default
   price scale for the starter contracts? (Sum-of-all-cards on
   `[1,2,9,10]×4` ranges roughly 9–~90, so tick 1 with two-digit
   typical prices seems fine.)
5. **Opening price seeding.** Should the host be able to seed the
   book with initial bids/offers in setup? Or must trading discover
   prices from scratch in `playing`?

