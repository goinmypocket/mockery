# Strategy: `natural-player`

Models a discretionary human filling a target size with a configurable
mix of patience and panic. Lives as one **instance** per Poisson
arrival; closes itself when the target is reached.

## Behavior

On spawn the instance is given a signed target size (`targetQty`).
Positive → buy; negative → sell. Throughout this doc, "best" and
"penny" are direction-aware: for a buyer, **best** is the best bid and
**penny** means improving the offer by a tick; for a seller it's the
opposite.

All order actions experience a uniform `lagMs` delay (parameter).

### Phase 1 — Spawn sweep

If the current bid-ask spread (BAS) is *tight* — narrower than a fraction
`tightSpreadFrac` of the **25 % quantile** of historical BAS since
game start, floored at 1 tick — the instance **sweeps**: it lifts every
ask price up to `bestBid + tightSpreadFrac × bas25` (with the same
floor) until either the target is filled or the price ladder runs out.
If the historical 25 % quantile is `null` (the BAS has never been
tight enough to have a quantile yet), the instance just joins the best
bid with a passive limit at the current touch.

If the spread is *not* tight, fall through to Phase 2.

### Phase 2 — Initiate with passive pennying

Define a **width budget** = `widthInitTicks` (parameter, scaled by tick
size and aware of the historic median BAS — see `historicMedianGuard`).

While the best offer minus current price ≤ width budget:

- Penny the best offer (place a buy at `bestOffer − 1` for a buyer,
  ignoring the instance's own resting orders when computing the touch).
- If another participant pennies past the width budget, stop pennying
  and **enter Phase 3 (take)** — lift the offer for the remaining size.

If no action happens in this contract for `idleTicksTowardImpatience`
seconds, shrink the width budget linearly by `urgencyDecayPerSec`
toward 1 tick. (Helper: `secondsSinceLastAction`.) The decay models
the player getting more urgent the longer the market sits.

Once the width budget reaches 1 tick or below, the instance enters
**Phase 4 (urgent)**.

### Phase 3 — Take

Cross the spread for the remaining target. Place an aggressive IOC at
the best offer (or sweep multiple levels if `tightSpreadFrac` allows).
Closes the instance once filled.

### Phase 4 — Urgent

Width budget has decayed below 1 tick. The instance is now willing to
pay any price:

- Periodically (every `urgentPennyIntervalMs`) repenny the bid.
- If `currentPrice − ema(currentPrice) > panicThreshold`, switch to
  taking at the current best offer. `currentPrice` is the last trade
  price; when that's `null`, fall back to `bestBid` (the side the
  buyer would have to take); when that's also `null`, do nothing this
  tick.
- For a seller (`targetQty < 0`), the panic condition flips:
  `currentPrice − ema(currentPrice) < −panicThreshold`.

### Termination

The instance closes itself as soon as the cumulative filled qty
reaches `|targetQty|` (signed).

## Parameters

`lagMs` and `scope` live on the **profile** (consumed by `multiProfileBot`),
not on the strategy itself. Everything else is a strategy param.

| Name | Type | Default | Description |
|---|---|---|---|
| `targetQty` | int (non-zero, signed) | 5 | Signed target. Positive → buy, negative → sell. |
| `tightSpreadFrac` | number ∈ (0, 1] | 0.5 | Phase 1 sweep threshold: spread is "tight" if ≤ `frac × BAS_q25`, floored at 1 tick. |
| `widthInitTicks` | int ≥ 1 | 3 | Phase 2 width budget at spawn, in ticks. |
| `historicMedianGuard` | number ≥ 0 | 1.5 | Caps the width budget at `historicMedianGuard × historic median BAS / tickSize`. Keeps the budget grounded in market conditions. |
| `urgencyDecayPerSec` | number ≥ 0 | 0.05 | Linear shrink rate of the width budget per second of no contract action. |
| `idleSecondsBeforeDecay` | number ≥ 0 | 1.0 | Seconds of inactivity before urgency decay kicks in. |
| `urgentPennyIntervalMs` | int ≥ 100 | 1000 | Repenny cadence once urgent. |
| `panicThreshold` | number > 0 | 1.5 | Buy-side trigger for Phase-4 takeover. Symmetric for sellers. |
| `panicEmaHalfLifeSec` | number > 0 | 5 | Half-life of the EMA in the panic condition. |

Profile-level (set on the `Profile` passed to `multiProfileBot`):

| Field | Description |
|---|---|
| `lagMs` | Action lag in ms — consumed via `subCtx.afterLag` on every place / cancel chain. |
| `scope` | `"instance"` or `"shared"`. Natural-player currently uses per-instance accounting regardless of `scope`; the field is reserved for strategies that want to gate on `ctx.myPosition()` instead. |

## Helpers used

- `weightedMid(book)` — fair value estimate; null when one-sided.
- `marketWidth(book)` — best offer − best bid; null when one-sided.
- `isMarketSafe(book)` — both sides present.
- `timeEma(ctx, key, halfLife, sample, { seed })` — for the panic
  comparison's reference price.
- `contractPrior(snap, contractId)` — for the EMA seed (so the panic
  test isn't undefined at spawn).
- `TimeSeries<number>` (in `marketstats`) — for BAS quantiles and
  median, fed by an `onBookUpdate` push.
- `secondsSinceLastAction(snap, contractId)` — derived from the
  contract's last trade timestamp.

## Edge cases

- `targetQty = 0`: rejected at profile validation.
- All four phases respect `scope`. With `scope: "shared"`, the
  termination condition uses the bot's whole position relative to its
  initial position when the instance spawned (so a panic-spawning
  natural alongside a market-maker on the same bot doesn't accidentally
  close the maker's flow).
- If `contractPrior` returns null (no contract in snapshot), the EMA
  starts uninitialised and the panic check is skipped until the EMA
  warms up via real observations.
- If the bot is short on the side it's supposed to be sweeping (no
  liquidity at all), Phase 1 silently no-ops and the instance proceeds
  to Phase 2.

## Implementation status

Landed (`server/bots/strategies/natural-player.ts`).

- **Per-instance fill attribution.** Aggressor-side fills are recorded
  synchronously from the placement call's return value. Resting-side
  fills are picked up in `onMyFill` by matching `trade.restingOrderId`
  against the instance's `myOrderIds` set. So two same-direction
  concurrent instances each close at their own `targetQty`.
- **Single contract per instance**: the strategy picks `snapshot.contracts[0]`.
  Multi-contract steering is a parameter for later.
- **Threshold-breach detection in Phase 2** uses the touch-level
  `othersBestPrice` (excluding our own resting orders). A breach is
  defined as the current width exceeding the capped width budget — see
  §Behavior Phase 2.
