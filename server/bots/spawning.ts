// =============================================================================
// Multi-instance bot spawner. See docs/bot-spawning-model.md for the
// model: a single registered BotStrategy that internally hosts many
// concurrent sub-instances, each running an inner strategy with its
// own params, local scratch, and lifecycle.
//
//  - Permanent profiles instantiate at onStart.
//  - Poisson profiles schedule themselves; each arrival spawns a new
//    sub-instance and reschedules the next arrival.
//  - All lifecycle hooks fan out to every live sub-instance.
//  - Sub-instances close themselves via `subCtx.close()`; the wrapper
//    cancels their timers and drops them.
//
// Lag is strategy-driven: the wrapper does NOT intercept action calls
// (place/cancel/IOC) to preserve their synchronous return contract.
// Strategies that need lag wrap their decisions in `subCtx.afterLag`
// (or call `subCtx.setTimer` directly).
// =============================================================================

import { makeRng, type Rng } from "../../engine/rng";
import type { OrderId } from "../../shared/ids";
import {
  type BotContext,
  type BotStrategy,
  type Params,
  type TimerHandle,
} from "./api";
import { unsafeUniformIntDistribution } from "pure-rand";

export interface Profile {
  /** Human-readable id for logs and debugging. Doesn't need to be unique. */
  readonly id: string;
  readonly strategy: BotStrategy;
  readonly params: Params;
  readonly spawn:
    | { readonly mode: "permanent" }
    | { readonly mode: "poisson"; readonly ratePerSec: number };
  /** Suggested lag the inner strategy uses via `subCtx.afterLag`. */
  readonly lagMs: number;
  /** "instance" → the strategy tracks its own fills via local state and
   *  `onMyFill`. "shared" → the strategy uses `ctx.myPosition()` which
   *  returns the bot entity's whole position. */
  readonly scope: "instance" | "shared";
}

export interface SpawnerConfig {
  readonly id?: string;                       // strategy id (default "multi-profile")
  readonly displayName?: string;
  readonly profiles: readonly Profile[];
  /** Seed for the Poisson-arrival RNG. Required for replay stability. */
  readonly seed: number;
}

/** Extended context handed to each sub-instance. Adds `shared` (cross-
 *  instance map owned by the wrapper), `profileId`, `afterLag`, and
 *  `close`. `params` and `local` are scoped to this instance. */
export interface SubBotContext extends BotContext {
  readonly shared: Map<string, unknown>;
  readonly profileId: string;
  /** OrderIds this sub-instance placed. The wrapper fans `onMyFill`
   *  to every live sub-instance; filter by this set if you want
   *  instance-scoped fill attribution. */
  readonly myOrderIds: ReadonlySet<OrderId>;
  /** Wrap an action in the profile's `lagMs` delay. The body runs after
   *  the delay; the returned TimerHandle lets the caller cancel it. */
  afterLag(fn: () => void): TimerHandle;
  /** Mark this instance complete. Cancels pending timers; subsequent
   *  hook fan-out skips it. */
  close(): void;
}

interface SubInstance {
  readonly profile: Profile;
  readonly local: Map<string, unknown>;
  readonly timers: Set<TimerHandle>;
  readonly orderIds: Set<OrderId>;
  closed: boolean;
  subCtx: SubBotContext;
}

export function multiProfileBot(config: SpawnerConfig): BotStrategy {
  let parentCtx: BotContext | null = null;
  const instances: SubInstance[] = [];
  const shared = new Map<string, unknown>();
  const rng = makeRng(config.seed);

  function spawn(profile: Profile): SubInstance {
    const ctx = parentCtx!;
    const local = new Map<string, unknown>();
    const timers = new Set<TimerHandle>();
    const orderIds = new Set<OrderId>();
    const inst: SubInstance = {
      profile, local, timers, orderIds, closed: false,
      subCtx: null as unknown as SubBotContext,
    };

    const subSetTimer = (ms: number, fn: (c: BotContext) => void): TimerHandle => {
      const h = ctx.setTimer(ms, (freshCtx) => {
        // Keep parentCtx synced to the orchestrator's just-refreshed
        // context so subCtx.snapshot (a getter into parentCtx) is
        // fresh inside timer-driven callbacks.
        parentCtx = freshCtx;
        timers.delete(h);
        if (!inst.closed) fn(freshCtx);
      });
      timers.add(h);
      return h;
    };

    const trackOrder = (r: ReturnType<BotContext["placeLimit"]>): typeof r => {
      if (r.ok && r.value.orderId !== null) orderIds.add(r.value.orderId);
      return r;
    };

    const subCtx: SubBotContext = {
      entityId: ctx.entityId,
      tableId: ctx.tableId,
      get snapshot() { return parentCtx!.snapshot; },
      myCode: ctx.myCode,
      myCodes: ctx.myCodes,
      params: profile.params,
      local,
      shared,
      profileId: profile.id,
      myOrderIds: orderIds,
      placeLimit: (args) => trackOrder(ctx.placeLimit(args)),
      placeIoc: (args) => ctx.placeIoc(args),
      cancel: (id) => { orderIds.delete(id); return ctx.cancel(id); },
      cancelAllMy: () => { orderIds.clear(); return ctx.cancelAllMy(); },
      myPosition: (cid) => ctx.myPosition(cid),
      myCash: () => ctx.myCash(),
      myMtmPnl: () => ctx.myMtmPnl(),
      myOpenOrders: () => ctx.myOpenOrders(),
      setTimer: subSetTimer,
      clearTimer: (h) => { if (timers.delete(h)) ctx.clearTimer(h); },
      afterLag: (fn) => subSetTimer(profile.lagMs, fn),
      close: () => closeInstance(inst),
    };
    inst.subCtx = subCtx;
    instances.push(inst);
    profile.strategy.onStart?.(subCtx);
    return inst;
  }

  function closeInstance(inst: SubInstance): void {
    if (inst.closed) return;
    inst.closed = true;
    for (const h of inst.timers) parentCtx!.clearTimer(h);
    inst.timers.clear();
    inst.orderIds.clear();
  }

  function scheduleNextArrival(profile: Profile): void {
    if (profile.spawn.mode !== "poisson") return;
    const rate = Math.max(profile.spawn.ratePerSec, 1e-9);
    const u = unsafeUniformIntDistribution(0, 0xFFFFFFFF, rng) / 0x1_0000_0000;
    const interMs = (-Math.log(1 - u) / rate) * 1000;
    parentCtx!.setTimer(interMs, () => {
      spawn(profile);
      scheduleNextArrival(profile);
    });
  }

  function fanOut<E extends keyof BotStrategy>(
    hook: E,
    invoke: (s: BotStrategy, ctx: SubBotContext) => void,
  ): void {
    void hook;
    for (const inst of instances) {
      if (inst.closed) continue;
      invoke(inst.profile.strategy, inst.subCtx);
    }
  }

  return {
    id: config.id ?? "multi-profile",
    displayName: config.displayName ?? "Multi-profile bot",
    onStart(ctx) {
      parentCtx = ctx;
      for (const p of config.profiles) {
        if (p.spawn.mode === "permanent") spawn(p);
        else scheduleNextArrival(p);
      }
    },
    onMarketData(ctx, snap) { parentCtx = ctx; fanOut("onMarketData", (s, c) => s.onMarketData?.(c, snap)); },
    onBookUpdate(ctx, cid)  { parentCtx = ctx; fanOut("onBookUpdate",  (s, c) => s.onBookUpdate?.(c, cid)); },
    onTrade(ctx, trade)     { parentCtx = ctx; fanOut("onTrade",       (s, c) => s.onTrade?.(c, trade)); },
    onMyFill(ctx, trade, side) { parentCtx = ctx; fanOut("onMyFill", (s, c) => s.onMyFill?.(c, trade, side)); },
    onEvent(ctx, event)     { parentCtx = ctx; fanOut("onEvent",       (s, c) => s.onEvent?.(c, event)); },
    onPhaseChange(ctx, oldP, newP) { parentCtx = ctx; fanOut("onPhaseChange", (s, c) => s.onPhaseChange?.(c, oldP, newP)); },
    onGameOver(ctx, result) {
      parentCtx = ctx;
      for (const inst of instances) {
        if (!inst.closed) inst.profile.strategy.onGameOver?.(inst.subCtx, result);
        closeInstance(inst);
      }
      instances.length = 0;
    },
  };
}
