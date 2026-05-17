# Strategy: `random-quoter`

Two-sided market-maker that posts a symmetric fixed-width spread
around a fair-value reference on every contract, refreshed on a
cadence. Cancels its quotes at every game event (the information
regime has changed, so prior quotes are stale).

> Educational template — don't trade against this for real money.

## Behavior

1. `onStart` arms a periodic timer (`requoteMs`) that calls `requote`.
2. `requote`:
   - Cancels all of the bot's resting orders.
   - For each contract:
     - Computes the reference price via `midOrFallback(snap, cid, fallbackMid)`
       — prefers book mid, falls back to last-trade price, then to
       `fallbackMid`. Skips the contract if everything is null
       *and* no fallback is provided (here `fallbackMid` is always
       supplied so this branch doesn't trigger in practice).
     - Builds a `twoSided(mid, spread, size)` quote (one level per side).
     - Places both sides as resting limit orders. Bid is skipped if
       `price ≤ 0`.
3. `onEvent` (any) cancels all of the bot's resting orders. The next
   `requote` re-posts them.

## Parameters

| Name | Type | Default | Description |
|---|---|---|---|
| `spread` | int ∈ [1, 50] | 2 | Half-width: distance from mid to each quote. |
| `size` | int ∈ [1, 100] | 1 | Quantity placed per side per requote. |
| `requoteMs` | int ∈ [250, 60_000] | 5000 | Cadence between full requotes. |
| `fallbackMid` | int ∈ [1, 100] | 25 | Reference price when book mid and last trade are both unavailable. |

## Helpers used

- `cadence(ctx, ms, fn)` — re-arming timer pattern.
- `midOrFallback(snap, cid, fallback)` — book-mid → last-trade → fallback chain.
- `twoSided(mid, spread, size)` — symmetric quote builder.

## Limitations

- No inventory awareness; will keep quoting both sides regardless of
  position.
- No spread / size dynamics; spread is constant across regimes.
- Doesn't filter own orders when computing mid — for ringing mid
  spirals, use a richer FV source (see `fairvalue.ts`).
