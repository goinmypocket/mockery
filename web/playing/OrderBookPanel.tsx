// =============================================================================
// OrderBookPanel — one row per contract, laid out as a fixed-column
// table. Click a cell to populate the Order Placer; Hit/Lift buttons
// fire IOC market orders against best bid / best offer.
// =============================================================================

import { useState, type ReactNode } from "react";
import type { ProjectedSnapshot, ProjectedBook, ProjectedLevel } from "../../engine/project";
import type { ContractId } from "../../shared/ids";
import { setSelection } from "../workspaceStore";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
}

export function OrderBookPanel({ snapshot, send }: Props): ReactNode {
  return (
    <table className="mk-book">
      <thead>
        <tr>
          <th />
          <th>Qty</th>
          <th />
          <th>Bid party</th>
          <th>Bid size</th>
          <th>Bid</th>
          <th>Contract</th>
          <th>Offer</th>
          <th>Offer size</th>
          <th>Offer party</th>
          <th />
          <th>Qty</th>
        </tr>
      </thead>
      <tbody>
        {snapshot.contracts.map((c) => (
          <ContractRows
            key={c.id}
            contractId={c.id}
            name={c.name}
            book={snapshot.books[c.id]}
            send={send}
          />
        ))}
      </tbody>
    </table>
  );
}

function ContractRows({
  contractId, name, book, send,
}: {
  contractId: ContractId;
  name: string;
  book: ProjectedBook | undefined;
  send(msg: unknown): void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [hitQty, setHitQty] = useState("1");
  const [liftQty, setLiftQty] = useState("1");
  const bestBid = book?.bids[0];
  const bestOffer = book?.offers[0];

  // Clicking ANY bid cell fills the Hit qty input AND populates the
  // Order Placer with a sell intent. Clicking ANY offer cell fills the
  // Lift qty input AND populates a buy intent.
  const onBidClick = (lvl: ProjectedLevel | undefined): void => {
    if (!lvl) return;
    setHitQty(String(lvl.size));
    setSelection({ contractId, side: "sell", price: lvl.price, qty: lvl.size });
  };
  const onOfferClick = (lvl: ProjectedLevel | undefined): void => {
    if (!lvl) return;
    setLiftQty(String(lvl.size));
    setSelection({ contractId, side: "buy", price: lvl.price, qty: lvl.size });
  };
  const populateContract = (): void => {
    setSelection({ contractId });
  };

  return (
    <>
      <tr className="mk-book__row">
        <td className="mk-book__expand">
          <button
            type="button" className="mk-button mk-button--small"
            onClick={() => setExpanded(!expanded)}
            title={expanded ? "Collapse" : "Expand"}
          >{expanded ? "▾" : "▸"}</button>
        </td>

        {/* Hit qty + Hit button (left side, sell-aggressive) */}
        <td className="mk-book__qty-cell">
          <input
            className="mk-book__qty" value={hitQty}
            onChange={(e) => setHitQty(e.target.value)}
            aria-label="Hit qty"
            title="Quantity for Hit (sell into best bid)"
            placeholder="qty"
            inputMode="numeric"
          />
        </td>
        <td className="mk-book__action-cell">
          <button
            type="button" className="mk-book__hit"
            disabled={!bestBid}
            onClick={() => {
              if (!bestBid) return;
              send({
                type: "PLACE_IOC", contractId, side: "sell",
                price: bestBid.price, qty: Number(hitQty) || 1,
              });
            }}
            title="Hit best bid (IOC sell)"
          >Hit</button>
        </td>

        {/* Bid party / size / price */}
        <td className="mk-code mk-book__cell" onClick={() => onBidClick(bestBid)}>
          {bestBid?.parties[0]?.code ?? ""}
          {bestBid && bestBid.parties.length > 1 ? (
            <span className="mk-muted"> +{bestBid.parties.length - 1}</span>
          ) : null}
        </td>
        <td className="mk-num mk-book__cell" onClick={() => onBidClick(bestBid)}>
          {bestBid?.size ?? ""}
        </td>
        <td className="mk-num mk-bid mk-book__cell" onClick={() => onBidClick(bestBid)}>
          {bestBid?.price ?? "—"}
        </td>

        {/* Contract */}
        <td className="mk-book__contract-cell">
          <button type="button" className="mk-book__contract" onClick={populateContract}>
            {name}
          </button>
        </td>

        {/* Offer price / size / party */}
        <td className="mk-num mk-offer mk-book__cell" onClick={() => onOfferClick(bestOffer)}>
          {bestOffer?.price ?? "—"}
        </td>
        <td className="mk-num mk-book__cell" onClick={() => onOfferClick(bestOffer)}>
          {bestOffer?.size ?? ""}
        </td>
        <td className="mk-code mk-book__cell" onClick={() => onOfferClick(bestOffer)}>
          {bestOffer?.parties[0]?.code ?? ""}
          {bestOffer && bestOffer.parties.length > 1 ? (
            <span className="mk-muted"> +{bestOffer.parties.length - 1}</span>
          ) : null}
        </td>

        {/* Lift button + Lift qty (right side, buy-aggressive) */}
        <td className="mk-book__action-cell">
          <button
            type="button" className="mk-book__hit"
            disabled={!bestOffer}
            onClick={() => {
              if (!bestOffer) return;
              send({
                type: "PLACE_IOC", contractId, side: "buy",
                price: bestOffer.price, qty: Number(liftQty) || 1,
              });
            }}
            title="Lift best offer (IOC buy)"
          >Lift</button>
        </td>
        <td className="mk-book__qty-cell">
          <input
            className="mk-book__qty" value={liftQty}
            onChange={(e) => setLiftQty(e.target.value)}
            aria-label="Lift qty"
            title="Quantity for Lift (buy from best offer)"
            placeholder="qty"
            inputMode="numeric"
          />
        </td>
      </tr>

      {expanded ? (
        <ExpandedLevels
          book={book}
          onBidClick={onBidClick}
          onOfferClick={onOfferClick}
        />
      ) : null}
    </>
  );
}

function ExpandedLevels({
  book, onBidClick, onOfferClick,
}: {
  book: ProjectedBook | undefined;
  onBidClick(lvl: ProjectedLevel | undefined): void;
  onOfferClick(lvl: ProjectedLevel | undefined): void;
}): ReactNode {
  if (!book) return null;
  const rows = Math.max(book.bids.length, book.offers.length, 3);
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => {
        const b = book.bids[i];
        const o = book.offers[i];
        return (
          <tr key={i} className="mk-book__row mk-book__row--level">
            <td />
            <td />
            <td />
            <td className="mk-code mk-book__cell" onClick={() => onBidClick(b)}>
              {b?.parties[0]?.code ?? ""}
            </td>
            <td className="mk-num mk-book__cell" onClick={() => onBidClick(b)}>
              {b?.size ?? ""}
            </td>
            <td className="mk-bid mk-num mk-book__cell" onClick={() => onBidClick(b)}>
              {b?.price ?? ""}
            </td>
            <td />
            <td className="mk-offer mk-num mk-book__cell" onClick={() => onOfferClick(o)}>
              {o?.price ?? ""}
            </td>
            <td className="mk-num mk-book__cell" onClick={() => onOfferClick(o)}>
              {o?.size ?? ""}
            </td>
            <td className="mk-code mk-book__cell" onClick={() => onOfferClick(o)}>
              {o?.parties[0]?.code ?? ""}
            </td>
            <td />
            <td />
          </tr>
        );
      })}
    </>
  );
}
