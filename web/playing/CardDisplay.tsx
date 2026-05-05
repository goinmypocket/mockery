// =============================================================================
// Card Display — informed seats row plus the public-card row.
//
// Each informed slot is keyed by the participant who was *originally*
// dealt that card. The viewer reveals the value of whichever card
// they currently hold, displayed under that card's original holder's
// banner. So a card stays attached to its initial holder's name for
// the rest of the game even after rotations move it elsewhere.
// =============================================================================

import type { ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";

interface Props {
  readonly snapshot: ProjectedSnapshot;
}

export function CardDisplay({ snapshot }: Props): ReactNode {
  const informedCount = snapshot.options.informedSeats;
  // `participants` is built in seat order in project.ts; filtering by
  // role preserves order, so `informedParticipants[i]` corresponds to
  // seat index `i`.
  const informedParticipants = snapshot.participants.filter((p) => p.role === "informed");
  const myOriginalSeat = snapshot.viewer.myCardOriginalSeat;
  const finished = snapshot.status === "finished";

  return (
    <div className="mk-cards-display">
      <div className="mk-cards-display__group">
        <h4>Informed seats</h4>
        <ul className="mk-cards-display__row">
          {informedParticipants.map((p, i) => {
            const revealedValue = snapshot.informedRevealedCards[i] ?? null;
            const isViewersCardSlot = myOriginalSeat === i;
            const isMyBanner = snapshot.viewer.myCode === p.code;
            return (
              <li
                key={p.code}
                className={`mk-card ${isViewersCardSlot ? "mk-card--mine" : ""} ${isMyBanner ? "mk-card--self-banner" : ""} ${finished && revealedValue !== null ? "mk-card--revealed" : ""}`}
              >
                <div className="mk-card__face">
                  {revealedValue !== null ? revealedValue : "?"}
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

      <div className="mk-cards-display__group">
        <h4>Card bank</h4>
        <ul className="mk-cards-display__row">
          {snapshot.options.cardValues.map((v) => (
            <li key={v} className="mk-card mk-card--bank">
              <div className="mk-card__face">{v}</div>
              <div className="mk-card__banner">×{snapshot.options.copiesPerValue}</div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
