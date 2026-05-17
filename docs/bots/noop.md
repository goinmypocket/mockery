# Strategy: `noop`

Test dummy. Implements no lifecycle hooks; takes no actions. Useful as
a placeholder when wiring up sessions, harness scenarios, or
multi-instance fixtures that need an inert participant.

## Parameters

None.

## Implementation

`server/bots/strategies/noop.ts` — a `BotStrategy` with only `id` and
`displayName` populated. The orchestrator's "missing hook" fallback
takes care of every dispatch (no-op).
