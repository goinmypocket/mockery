// =============================================================================
// Card Display — own private card (if informed), other informed seats as
// hidden, and the public-card row with revealed values shown.
// =============================================================================

import type { ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";

interface Props {
  readonly snapshot: ProjectedSnapshot;
}

export function CardDisplay({ snapshot }: Props): ReactNode {
  const informedCount = snapshot.options.informedSeats;
  const informedParticipants = snapshot.participants.filter((p) => p.role === "informed");

  return (
    <div className="mk-cards-display">
      <div className="mk-cards-display__group">
        <h4>Informed seats</h4>
        <ul className="mk-cards-display__row">
          {informedParticipants.map((p) => {
            const isMe = snapshot.viewer.myCode === p.code;
            return (
              <li key={p.code} className={`mk-card ${isMe ? "mk-card--mine" : ""}`}>
                <div className="mk-card__face">
                  {isMe && snapshot.viewer.myCard !== null ? snapshot.viewer.myCard : "?"}
                </div>
                <div className="mk-card__banner">{p.code}</div>
              </li>
            );
          })}
          {/* If informedCount has gaps from no participants list (shouldn't), fill */}
          {Array.from({ length: Math.max(0, informedCount - informedParticipants.length) }).map((_, i) => (
            <li key={`empty-${i}`} className="mk-card mk-card--empty">
              <div className="mk-card__face">?</div>
              <div className="mk-card__banner">—</div>
            </li>
          ))}
        </ul>
      </div>

      <div className="mk-cards-display__group">
        <h4>Public cards</h4>
        <ul className="mk-cards-display__row">
          {snapshot.publicCards.map((v, i) => (
            <li key={i} className={`mk-card ${v !== null ? "mk-card--revealed" : ""}`}>
              <div className="mk-card__face">{v ?? "?"}</div>
              <div className="mk-card__banner">P{i + 1}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
