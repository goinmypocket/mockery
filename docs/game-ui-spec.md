# Mockery — UI spec

The Mockery UI is a **modular workspace**: each module is a panel
that the user can show/hide, resize, and drag-rearrange in a
docking layout. Think Jupyter Lab or VS Code's panel system. The
platform mounts a single `PlatformApp` for Mockery; everything
described here lives inside that mount.

This spec is the UI authority. Engine behaviour and named
parameters live in `game-spec.md`.

> **Status:** v0.4 spec. Variable names match `game-spec.md` §1.

> Throughout this spec, "participant" in UI panels means the
> participant's **2-letter code** (engine spec §11), not their
> display name. Whether a viewer additionally sees `code → name`
> links is governed by `identityReveal`.

---

## 1. Workspace shell

### 1.1 Docking framework

We use **`rc-dock`** (chosen for tabs + floating panels + JSON
layout state). Mockery's PlatformApp wraps it and feeds a default
layout the first time the user opens a table.

Layout state is persisted to `localStorage` per `(userId, tableId)`
plus a per-user **layout library** (also in `localStorage`).

### 1.2 Layout library

Users can save, name, and reload multiple docking arrangements.

The workspace top bar exposes a "Layout" menu:

- **Save current as…** — prompt for a name, store under that name.
- **Load:** — submenu listing saved layouts; click to switch.
- **Rename / delete** — edit existing entries.
- **Set as default for new tables** — marks one of the saved
  layouts as the default Mockery brings up next time.
- **Reset to built-in default** — discards the user's overrides.

Storage shape:

```
localStorage["mockery.layouts"] = {
  default: "trading-3-panel",
  layouts: {
    "trading-3-panel": <rc-dock layout JSON>,
    "monitor-only":   <rc-dock layout JSON>,
    ...
  }
}
```

Layouts are device-local. Cross-device sync is out of scope for
v0.1.

### 1.3 Default layout

```
┌─────────────────────────────────────────────────────────────┐
│ TopBar: phase | next event countdown | layout menu | host…   │
├──────────────┬──────────────────────────────┬───────────────┤
│ Card Display │   Order Book                 │ Position +    │
│              │                              │ PnL Tracker   │
│              ├──────────────────────────────┤               │
│              │   TNS (Time & Sales)         │               │
├──────────────┴──────────────────────────────┴───────────────┤
│ Order Placer (always visible, sticks to bottom by default)   │
└─────────────────────────────────────────────────────────────┘
```

### 1.4 Module registry

`web/modules/index.ts` exports a registry:

```ts
{
  cardDisplay:    { title: "Cards",       Component: CardDisplay },
  tns:            { title: "Trades",      Component: TnsPanel },
  orderBook:      { title: "Order Book",  Component: OrderBookPanel },
  orderPlacer:    { title: "Place Order", Component: OrderPlacer },
  positionPnl:    { title: "Positions",   Component: PositionPnlPanel },
  hostControls:   { title: "Host",        Component: HostControlsPanel },
  myOrders:       { title: "My Orders",   Component: MyOrdersPanel },
  setup:          { title: "Setup",       Component: SetupPanel }, // §10
}
```

A "+" menu in the workspace bar opens an "Add panel" picker that
lets the user spawn another instance of any registered module.
Multiple instances of the same module are allowed (e.g. two TNS
panels with different filters).

### 1.5 Cross-module communication

Modules communicate through a shared **Workspace store** (Zustand
or context):

- `selection` — `{ contractId, price?, qty?, side? }` set whenever
  the user clicks something in another module that should populate
  the Order Placer.

The Order Placer subscribes to `selection` and updates its inputs.

---

## 2. Module: Card Display

Shows every card the viewer is allowed to see and a placeholder for
every card they aren't. Unseen cards **never reach this client** —
the panel renders `?` solely from the per-recipient projected
state.

Layout:

```
Informed seats         Public cards
─────────────────      ──────────────────
Alice (you)  [ 7 ]     [ ? ] [ ? ] [ 3 ]
Bob          [ ? ]
Carol        [ ? ]
Dave         [ ? ]
Eve          [ ? ]
Frank        [ ? ]
```

Behaviour:

- The viewer's own card (if informed) is rendered with a distinct
  border and the seat label "(you)".
- Other informed seats show `?` until rotation; even after rotation
  the values stay hidden — only the viewer's own slot updates with
  the value they just received.
- Public slots show face when revealed and `?` otherwise.
- A subtle animation flips the relevant cards on the corresponding
  `EVENT` message.

## 3. Module: TNS (Time & Sales)

A scrollable trade tape. Most recent first.

| Column | Notes |
|---|---|
| Time | local-time HH:MM:SS, server-truth |
| Buyer | blue text. Bold if aggressor. |
| Seller | red text. Bold if aggressor. |
| Contract | name |
| Price | right-aligned, monospaced |
| Quantity | right-aligned, monospaced |

Row background colour is keyed to `phase` (e.g. phase 0 pale white,
phase 1 pale blue, phase 2 pale green, ...). A small chip on the
left edge shows the phase number.

Filters (toolbar above the table):

- **Participant:** dropdown of all participants. "All trades by X."
- **Contract:** dropdown of contracts.
- **Participant + Contract:** apply both.
- **Aggressor only:** if a participant is selected, filters to
  "trades where this participant aggressed".
- **Phase:** chip-bar showing current phases; click chips to toggle
  visibility.

Filter state is module-local; spawning a second TNS panel gives an
independent filter set.

System rows (events, host actions) appear in TNS with
participant = "system". They render with a distinct icon and italic
text and are not subject to participant filters.

## 4. Module: Order Book

One row per contract, expandable to N levels.

### 4.1 Collapsed row

```
[Hit-Bid]  [BidParty1]  (+N)  [BidSize] (TotalSize)  [BidPrice] -- [ContractName] -- [OfferPrice]  [OfferSize] (TotalSize)  (+N)  [OfferParty1]  [Lift-Offer]
```

- **Hit-Bid** — small button with an inline qty textbox
  (default `1`). Clicking sends `PLACE_IOC(side: sell,
  price: bestBidPrice, qty: textbox)`.
- **Lift-Offer** — same on the offer side.
- **BidParty1 / OfferParty1** — first-in-line participant at top of
  book. `(+N)` indicates `N` more participants behind at that price
  level.
- **BidSize / OfferSize** — top-of-book size in the FIFO sense (the
  first party's quantity).
- **(TotalSize)** — sum of all parties at that price level.
- Clicking the **bid region** (anywhere except the hit button)
  populates Order Placer with `{contractId, price: bidPrice, qty:
  bidSize, side: sell}`.
- Clicking the **offer region** populates with side `buy`.
- Clicking the **contract name in the middle** populates only
  `{contractId}`, leaving price/qty unchanged.

### 4.2 Expanded row

A chevron on the row's left expands it. Expanded view shows up to
`levelsToShow` levels (default 3, configurable per contract via a
gear menu). Each level renders:

```
  L2  [Bid Party]  (+N)  [Size]  [Price] -- [Price]  [Size]  (+N)  [Offer Party]
```

Clicking any deeper-level price populates Order Placer the same way
(qty defaults to that level's size).

### 4.3 No-quote rendering

Empty side: render `—  —  —` and disable the hit/lift button.

## 5. Module: Order Placer

Inputs:

- **Contract** — dropdown (default) OR a row of buttons (one per
  contract) when "Pin contracts as buttons" is toggled in module
  settings.
- **Side** — segmented `Buy / Sell`.
- **Price** — numeric textbox; integer.
- **Qty** — numeric textbox; integer ≥ 1.
- **Type** — segmented `Limit / IOC`. Default `Limit`.
- **Submit** — primary button. Label dynamically reflects e.g.
  `Buy 5 ABC @ 42`.

Behaviour:

- On `selection` updates from other modules, the relevant fields
  populate but do not auto-submit.
- After submission, all fields clear except contract.
- Validation: client-side checks integer and positive; server is
  authoritative.
- Rejected orders show a red toast AND an inline error chip in the
  Order Placer (`⚠ <reason>` with a dismiss `×`), the same pattern
  Coke and Iron uses for `INTENT_REJECTED`.

## 6. Module: Position + PnL Tracker

A combined panel with two tabs.

### 6.1 Position tab

Table with one row per participant and one column per contract,
plus a "Total |size|" column and per-row total.

- Long values shown black, short red.
- Zero rows can be hidden via a "Hide flat" toggle.
- A "Hide uninformed" toggle hides participants the engine has
  flagged uninformed (this is OK because role is public; cards are
  not).
- Bot entities are tagged with a small "BOT" badge but are
  otherwise treated identically to players.

### 6.2 PnL tab

Same table shape, cells show `pos × mark + cash` per contract and
the row total.

- Mark mode indicator per contract: `mid` if both sides quoted,
  `last` otherwise, `—` if no trades and no quotes.
- A "Show settled" toggle (only enabled in `finished`) replaces
  marks with settlement values.

## 7. Module: Host Controls

Visible only to the table host (the platform tells the client who
the host is). Non-host users see neither this module nor a button
to spawn it. The countdown remains visible to everyone in the top
bar.

The panel has three sub-sections, all stacked:

### 7.1 Trigger controls — auto mode

Visible when `eventMode === "auto"`:

- Large monospaced **next-event countdown**.
- **Delay event** — `+30s`, `+60s`, custom input (positive or
  negative seconds).
- **Prepone event** — fires next event immediately.

### 7.2 Trigger controls — manual mode

Visible when `eventMode === "manual"`:

- A prominent **Fire next event** button that displays the head of
  the queue (e.g. "Fire: REVEAL slot 2"). Disabled if the queue is
  empty.
- A separate **End game** section, expanded only when the queue is
  empty:
  - **End game now** — primary destructive button. Confirmation
    modal listing what will settle.
  - **Start grace timer** — number input (seconds) + button. Once
    armed, the section shows the countdown and a **Cancel grace
    timer** button.

### 7.3 Event queue editor

A drag-rearrangeable vertical list of queued events. Each card
shows the event type and (for REVEAL_PUBLIC) the target slot index
(or "auto" for "next hidden slot"). Controls:

- **+ Add** — picker: `ROTATE_INFORMED` or `REVEAL_PUBLIC` (with
  optional slot dropdown listing still-hidden slots).
- Drag handles for reordering.
- ✕ on each card to remove it.
- The head of the queue is visually distinguished as
  "next" — in auto mode it's "in flight"; in manual mode it's
  the one **Fire next event** will trigger.

### 7.4 Bot entities (read-only summary)

A list of active bot entities with their wired strategy id and a
last-seen timestamp. Adding/removing entities or rewiring
strategies mid-game is not supported in v0.1; that's a
setup-phase action (§10).

## 8. Module: My Orders

Table of the viewer's resting orders across all contracts. Columns:
`Time, Contract, Side, Price, Qty (filled / remaining), Cancel`.

- Cancel button issues `CANCEL_ORDER`.
- Filled-but-resting partials show e.g. `4 / 6` with a progress
  bar.
- Hidden by default for spectators.

## 9. Top bar

Always visible above the docking area:

- Game name + table name on the left.
- Phase indicator chip ("P3").
- **Next event countdown** — in auto mode, large monospaced timer
  like `04:21`, driven by `EVENT_TIMER` ticks; client interpolates
  between ticks. In manual mode, shows `MANUAL` instead, or the
  grace-timer countdown if one is armed.
- **Next event hint** — the queue is public, so this shows the head
  always: e.g. "Next: REVEAL slot 2", or "Queue empty" when nothing
  is pending.
- **Layout menu** (§1.2).
- **Add panel** menu (§1.4).
- Connection status dot.

## 10. Module: Setup (host) / Setup viewer (others)

Mockery has a `setup` phase between platform-lobby and `playing`
(see engine spec §3). During `setup`:

### 10.1 Host's view

A single full-screen Setup panel (the workspace's other modules
are hidden in setup). Sections:

#### a) Contract libraries + table contracts

Three-pane editor:

- **Shared library** (left, with a "shared" badge): contracts
  that ship with Mockery (`config/shared-contracts.json`,
  read-only at runtime). Includes the starter pack (engine spec
  §5.5). Buttons per row: **Preview**, **Copy to my library →**,
  **Add to table →**.
- **My library** (middle): the host's saved contracts. Buttons:
  **+ New**, **Duplicate**, **Edit**, **Delete**, **Add to
  table →**.
- **In this table** (right): contracts pinned to the current
  table. Each row: name, description, **Edit-in-table** (creates
  a one-off override that does not write back to either library),
  **✕ remove**. Rows imported from the shared library show a
  "shared" badge until edited.

Editing a contract opens a modal with:

- Name, description, payoff source (multi-line code editor with
  JS syntax highlight).
- A **Validate** button runs the static denylist + sandbox compile
  + the engine's fuzz check (engine spec §5.3). Errors render
  inline.
- **Save to my library**, **Save to table only**, **Cancel**.
- "Shared library" entries cannot be edited in place — the
  modal's Save targets a copy.

Inline validator caveats: forbidden tokens (`require`, `import`,
`eval`, `Function`, `process`, `globalThis`, `__proto__`,
`constructor`).

#### b) Event mode + queue editor

- A segmented control: **Auto** / **Manual**. Auto reveals the
  `eventIntervalMin/Max` numeric inputs; Manual reveals the
  `endGameGraceSec` input.
- Below: the queue editor (same component used by Host Controls
  §7.3). The queue can be empty here — the host builds it up
  before starting. "Start Trading" is gated on a non-empty queue.

#### c) Bot entities

A list editor with one row per entity:

- **Entity name** text input — must be exactly 2 letters
  (engine spec §11), used as the entity's code directly.
- **Strategy** dropdown — populated from the server-registered
  strategy registry (engine spec §14 Q1, bot author guide §3).
  Choices include `(none)` for a dormant entity.
- ✕ Remove.
- A **+ Add entity** button below the list.

#### d) Participant codes and anonymization

A table with one row per participant (players + bots):

| Display name | Role | Code |
|---|---|---|
| Alice (you) | informed | `AB` |
| Bob | informed | `CD` |
| ... | | |

- The **Code** column is editable for each row (free-form 2-letter
  text, case enforced when `enforceCaseByRole`). Collisions are
  flagged inline.
- Above the table: a control for `codeMode` (`alpha` /
  `random`), a button **Reshuffle** (regenerates from current
  mode), a checkbox **Enforce case by role**.
- A separate radio for `identityReveal`: `All` / `Host only` /
  `Listed` (with a multiselect for userIds when `Listed`).

#### e) Start Trading

A primary button at the bottom. Disabled while:

- contracts list is empty,
- event queue is empty,
- any contract is invalid.

A pre-flight panel above the button summarises the deck
composition (`cardValues × copiesPerValue = deckSize`,
`cardsInPlay`), the event queue length, the contract count.

### 10.2 Non-host view during setup

A read-only view showing:

- A "Waiting for host to start" banner with the host's display
  name.
- The current contracts list (name + description + source — source
  is public per §10.4 of the engine spec).
- The selected event mode (auto / manual) and the full event
  queue. The queue is public information (engine spec §6.5).
- The live deck composition / scenario summary.
- The list of bot entities and their wired strategy ids.

## 11. Bots and the UI

Bots run server-side and trade as ordinary participants (engine
spec §7). UI consequence:

- Bots appear in TNS, Position, and PnL panels with a small `BOT`
  badge next to the entity name.
- Players cannot see which bot strategy is behind an entity (or
  whether multiple bots back the same entity); that's an
  intentional information asymmetry in the host's favour.
- The host's setup module can configure the entity name list; bot
  strategies are wired server-side.

## 12. Accessibility & visuals

- Keyboard: focus rings on all clickable order-book regions; arrow
  keys move price/qty in Order Placer; `Enter` submits.
- Colour-blind mode: replace bid-blue / offer-red with shape and
  position cues (caret up/down) and a configurable palette.
- Numeric columns use a tabular monospaced font.

## 13. Out of scope for v0.1

- Charts / time-series price plots.
- Cross-device layout sync (`localStorage`-only per device).
- Theming beyond a single dark default.
- Replays / scrubbing after `GAME_OVER`. Trade history is shown as
  a static post-game review.

## 14. Open UI questions

1. Layout menu placement: top bar OR a dedicated icon in the
   workspace chrome?
2. Code editor for payoff source: simple `<textarea>` or a
   lightweight library like CodeMirror? Affects bundle size.
3. Order Book: do we want a depth-chart visualisation alongside
   the level list?

