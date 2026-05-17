// =============================================================================
// Cadence helper. Owns the "run fn every N ms" pattern with proper
// timer re-arming and a single cleanup handle stored under a
// well-known local key. Random-quoter and any other "requote on a
// timer" strategy uses this; cleanup runs automatically on game over
// because the orchestrator cancels all bot timers there anyway, but
// we still expose `stop(ctx)` for explicit teardown (e.g. in
// `onPhaseChange` if a strategy wants to pause cadence at event
// boundaries).
// =============================================================================

import type { BotContext, TimerHandle } from "../api";

const TIMER_KEY = "__cadenceTimer";

/** Schedule `fn` to run immediately, then every `ms` afterward. The
 *  re-arm is owned here — strategies don't have to manage the timer
 *  handle. Calling `cadence` a second time replaces the previous
 *  schedule (the old timer is cancelled). */
export function cadence(ctx: BotContext, ms: number, fn: () => void): void {
  stopCadence(ctx);
  const tick = (): void => {
    fn();
    const handle = ctx.setTimer(ms, tick);
    ctx.local.set(TIMER_KEY, handle);
  };
  tick();
}

/** Cancel a previously-started cadence. No-op if none is running.
 *  Named `stopCadence` rather than `stop` so the helpers barrel can
 *  flat-re-export without colliding with future stop-something
 *  helpers. */
export function stopCadence(ctx: BotContext): void {
  const handle = ctx.local.get(TIMER_KEY) as TimerHandle | undefined;
  if (handle !== undefined) {
    ctx.clearTimer(handle);
    ctx.local.delete(TIMER_KEY);
  }
}
