// =============================================================================
// Event queue editor. Used in setup AND playing phases (the host can
// also re-order events mid-game per spec §6.3). The intent prefix
// switches between SETUP_QUEUE_* and QUEUE_* depending on `setupPhase`.
// =============================================================================

import { useState, type ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";
import type { EventQueueEntry } from "../../shared/types";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
  readonly setupPhase: boolean;
}

export function EventQueueEditor({ snapshot, send, setupPhase }: Props): ReactNode {
  const queue = snapshot.eventQueue;
  const prefix = setupPhase ? "SETUP_QUEUE_" : "QUEUE_";
  const isHost = snapshot.viewer.userId === snapshot.tableHostUserId;

  const [adding, setAdding] = useState<"ROTATE_INFORMED" | "REVEAL_PUBLIC" | "">("");
  const [revealSlot, setRevealSlot] = useState<string>("auto");

  const append = (): void => {
    if (!adding) return;
    const event: EventQueueEntry =
      adding === "ROTATE_INFORMED"
        ? { type: "ROTATE_INFORMED" }
        : { type: "REVEAL_PUBLIC", slotIndex: revealSlot === "auto" ? null : Number(revealSlot) };
    send({ type: `${prefix}APPEND`, event });
    setAdding("");
    setRevealSlot("auto");
  };

  return (
    <div className="mk-queue">
      <ol className="mk-queue__list">
        {queue.map((e, idx) => (
          <li key={idx} className="mk-queue__item">
            <span className="mk-queue__pos">{idx + 1}</span>
            <span className="mk-queue__type">
              {e.type === "ROTATE_INFORMED"
                ? "ROTATE INFORMED"
                : `REVEAL slot ${e.slotIndex ?? "auto"}`}
            </span>
            {isHost ? (
              <span className="mk-queue__actions">
                {idx > 0 ? (
                  <button
                    type="button" className="mk-button mk-button--small"
                    onClick={() => send({ type: `${prefix}MOVE`, from: idx, to: idx - 1 })}
                  >↑</button>
                ) : null}
                {idx < queue.length - 1 ? (
                  <button
                    type="button" className="mk-button mk-button--small"
                    onClick={() => send({ type: `${prefix}MOVE`, from: idx, to: idx + 1 })}
                  >↓</button>
                ) : null}
                <button
                  type="button" className="mk-button mk-button--small mk-button--danger"
                  onClick={() => send({ type: `${prefix}REMOVE`, idx })}
                >×</button>
              </span>
            ) : null}
          </li>
        ))}
      </ol>

      {isHost ? (
        <div className="mk-queue__add">
          <select value={adding} onChange={(e) => setAdding(e.target.value as never)}>
            <option value="">Add event…</option>
            <option value="ROTATE_INFORMED">Rotate informed</option>
            <option value="REVEAL_PUBLIC">Reveal public card</option>
          </select>
          {adding === "REVEAL_PUBLIC" ? (
            <select value={revealSlot} onChange={(e) => setRevealSlot(e.target.value)}>
              <option value="auto">auto (next hidden)</option>
              {snapshot.publicCards.map((v, i) =>
                v === null ? <option key={i} value={i}>slot {i}</option> : null,
              )}
            </select>
          ) : null}
          <button
            type="button" className="mk-button" onClick={append}
            disabled={!adding}
          >Add to queue</button>
        </div>
      ) : null}
    </div>
  );
}
