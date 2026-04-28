// =============================================================================
// TopBar — phase chip, next-event countdown, next-event hint, host id.
// =============================================================================

import { useEffect, useState, type ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";

export function TopBar({ snapshot }: { snapshot: ProjectedSnapshot }): ReactNode {
  // Tick locally between server EVENT_TIMER ticks for a smoother countdown.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, []);
  void tick;

  const next = snapshot.eventQueue[0];
  const countdownLabel = formatCountdown(snapshot, snapshot.eventMode);

  return (
    <header className="mk-topbar">
      <div className="mk-topbar__title">Mockery</div>
      <div className="mk-topbar__phase">P{snapshot.phase}</div>
      <div className="mk-topbar__countdown">{countdownLabel}</div>
      <div className="mk-topbar__next">
        {next
          ? `Next: ${next.type === "ROTATE_INFORMED" ? "ROTATE" : `REVEAL ${next.slotIndex ?? "auto"}`}`
          : "Queue empty"}
      </div>
    </header>
  );
}

function formatCountdown(snap: ProjectedSnapshot, mode: "auto" | "manual"): string {
  if (mode === "manual") {
    if (snap.graceTimerMs !== null) return `GRACE ${formatMs(snap.graceTimerMs)}`;
    return "MANUAL";
  }
  if (snap.msUntilNextEvent !== null) return formatMs(snap.msUntilNextEvent);
  return "—";
}

function formatMs(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60).toString().padStart(2, "0");
  const s = (totalSec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}
