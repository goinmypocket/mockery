// =============================================================================
// SessionClock — a minimal clock + timer abstraction so the session is
// testable without real wall-clock waits.
//
// The session never calls `Date.now()` or `setTimeout` directly; it
// goes through here. Production wires up `realClock`; tests inject
// `fakeClock` and advance it manually.
// =============================================================================

export type TimerHandle = symbol;

export interface SessionClock {
  now(): number;
  schedule(ms: number, fn: () => void): TimerHandle;
  cancel(handle: TimerHandle): void;
}

export const realClock: SessionClock = {
  now() {
    return Date.now();
  },
  schedule(ms, fn) {
    const tag = Symbol("timer");
    const t = setTimeout(fn, Math.max(0, ms));
    realTimers.set(tag, t);
    return tag;
  },
  cancel(handle) {
    const t = realTimers.get(handle);
    if (t !== undefined) {
      clearTimeout(t);
      realTimers.delete(handle);
    }
  },
};

const realTimers = new Map<TimerHandle, ReturnType<typeof setTimeout>>();

// ---------------------------------------------------------------------------
// FakeClock for tests. Time only advances when the test explicitly calls
// `advance(ms)`. Scheduled callbacks fire when their target is reached.
// ---------------------------------------------------------------------------

interface ScheduledTask {
  readonly handle: TimerHandle;
  readonly fireAt: number;
  readonly fn: () => void;
}

export class FakeClock implements SessionClock {
  private current = 0;
  private tasks: ScheduledTask[] = [];

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  schedule(ms: number, fn: () => void): TimerHandle {
    const handle = Symbol("fake-timer");
    this.tasks.push({ handle, fireAt: this.current + Math.max(0, ms), fn });
    this.tasks.sort((a, b) => a.fireAt - b.fireAt);
    return handle;
  }

  cancel(handle: TimerHandle): void {
    this.tasks = this.tasks.filter((t) => t.handle !== handle);
  }

  /** Advance virtual time by `ms`. Callbacks scheduled to fire within
   *  the new range execute synchronously, in fire-time order. New
   *  schedules done from inside a callback are honoured (they may fire
   *  during the same advance call if their target is within range). */
  advance(ms: number): void {
    const target = this.current + ms;
    while (true) {
      const next = this.tasks[0];
      if (!next || next.fireAt > target) break;
      this.tasks.shift();
      this.current = next.fireAt;
      next.fn();
    }
    this.current = target;
  }

  pendingTaskCount(): number {
    return this.tasks.length;
  }
}
