// =============================================================================
// HostControlsPanel — visible only to the host. Auto-mode and manual-mode
// trigger sections, the queue editor, and (manual mode) the end-game
// controls.
// =============================================================================

import { useState, type ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";
import { EventQueueEditor } from "../setup/EventQueueEditor";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
}

export function HostControlsPanel({ snapshot, send }: Props): ReactNode {
  return (
    <div className="mk-host">
      {snapshot.eventMode === "auto" ? <AutoControls send={send} /> : <ManualControls snapshot={snapshot} send={send} />}
      <div className="mk-host__queue">
        <h4>Event queue</h4>
        <EventQueueEditor snapshot={snapshot} send={send} setupPhase={false} />
      </div>
    </div>
  );
}

function AutoControls({ send }: { send(msg: unknown): void }): ReactNode {
  const [delaySec, setDelaySec] = useState("30");
  return (
    <div className="mk-host__auto">
      <button
        type="button" className="mk-button"
        onClick={() => send({ type: "DELAY_NEXT_EVENT", seconds: 30 })}
      >+30s</button>
      <button
        type="button" className="mk-button"
        onClick={() => send({ type: "DELAY_NEXT_EVENT", seconds: 60 })}
      >+60s</button>
      <input
        className="mk-host__delay-input" type="number" value={delaySec}
        onChange={(e) => setDelaySec(e.target.value)}
      />
      <button
        type="button" className="mk-button"
        onClick={() => send({ type: "DELAY_NEXT_EVENT", seconds: Number(delaySec) || 0 })}
      >Delay (s)</button>
      <button
        type="button" className="mk-button mk-button--primary"
        onClick={() => send({ type: "PREPONE_NEXT_EVENT" })}
      >Prepone</button>
    </div>
  );
}

function ManualControls({
  snapshot, send,
}: {
  snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
}): ReactNode {
  const queueEmpty = snapshot.eventQueue.length === 0;
  const head = snapshot.eventQueue[0];
  const [graceSec, setGraceSec] = useState("60");
  const graceArmed = snapshot.graceTimerMs !== null;

  return (
    <div className="mk-host__manual">
      <button
        type="button" className="mk-button mk-button--primary mk-button--large"
        disabled={queueEmpty}
        onClick={() => send({ type: "FIRE_NEXT_EVENT" })}
      >
        Fire next event
        {head ? `: ${head.type === "ROTATE_INFORMED" ? "ROTATE" : `REVEAL ${head.slotIndex ?? "auto"}`}` : ""}
      </button>

      {queueEmpty ? (
        <div className="mk-host__end">
          <button
            type="button" className="mk-button mk-button--danger mk-button--large"
            onClick={() => {
              if (window.confirm("End the game and settle now?")) send({ type: "END_GAME" });
            }}
          >End game now</button>

          {graceArmed ? (
            <button
              type="button" className="mk-button"
              onClick={() => send({ type: "CANCEL_GRACE_TIMER" })}
            >Cancel grace timer</button>
          ) : (
            <span className="mk-host__grace-row">
              <input
                className="mk-host__grace-input" type="number" value={graceSec}
                onChange={(e) => setGraceSec(e.target.value)}
              />
              <button
                type="button" className="mk-button"
                onClick={() => send({ type: "START_GRACE_TIMER", seconds: Number(graceSec) || 0 })}
              >Start grace timer (s)</button>
            </span>
          )}
        </div>
      ) : (
        <p className="mk-muted">Clear the queue to enable end-game controls.</p>
      )}
    </div>
  );
}
