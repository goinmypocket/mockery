// =============================================================================
// OrderBookPanel — one row per contract. Click any region to populate
// the Order Placer; hit/lift buttons fire IOC market orders.
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
    <div className="mk-book">
      {snapshot.contracts.map((c) => (
        <ContractRow
          key={c.id}
          contractId={c.id}
          name={c.name}
          book={snapshot.books[c.id]}
          send={send}
        />
      ))}
    </div>
  );
}

function ContractRow({
  contractId, name, book, send,
}: {
  contractId: ContractId;
  name: string;
  book: ProjectedBook | undefined;
  send(msg: unknown): void;
}): ReactNode {
  const [expanded, setExpanded] = useState(false);
  const [hitQty, setHitQty] = useState("1");
  const bestBid = book?.bids[0];
  const bestOffer = book?.offers[0];

  const populateBid = (lvl: ProjectedLevel): void => {
    setSelection({ contractId, side: "sell", price: lvl.price, qty: lvl.size });
  };
  const populateOffer = (lvl: ProjectedLevel): void => {
    setSelection({ contractId, side: "buy", price: lvl.price, qty: lvl.size });
  };
  const populateContract = (): void => {
    setSelection({ contractId });
  };

  return (
    <div className="mk-book__row">
      <div className="mk-book__line">
        <button
          type="button" className="mk-button mk-button--small"
          onClick={() => setExpanded(!expanded)}
          title={expanded ? "Collapse" : "Expand"}
        >{expanded ? "▾" : "▸"}</button>

        {/* Hit-bid IOC */}
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
        <input
          className="mk-book__qty" value={hitQty}
          onChange={(e) => setHitQty(e.target.value)}
          aria-label="Hit/lift qty"
        />

        {/* Bid side */}
        <button type="button" className="mk-book__side mk-book__side--bid"
          onClick={() => bestBid && populateBid(bestBid)}>
          {bestBid ? (
            <>
              <span className="mk-code">{bestBid.parties[0]?.code ?? "—"}</span>
              {bestBid.parties.length > 1 ? <span className="mk-muted"> (+{bestBid.parties.length - 1})</span> : null}
              <span className="mk-num"> {bestBid.parties[0]?.qty ?? 0}</span>
              <span className="mk-muted"> ({bestBid.size})</span>
              <span className="mk-num mk-bid"> @ {bestBid.price}</span>
            </>
          ) : <span className="mk-muted">— — —</span>}
        </button>

        {/* Contract name */}
        <button type="button" className="mk-book__contract" onClick={populateContract}>
          {name}
        </button>

        {/* Offer side */}
        <button type="button" className="mk-book__side mk-book__side--offer"
          onClick={() => bestOffer && populateOffer(bestOffer)}>
          {bestOffer ? (
            <>
              <span className="mk-num mk-offer">{bestOffer.price}</span>
              <span className="mk-num"> {bestOffer.parties[0]?.qty ?? 0}</span>
              <span className="mk-muted"> ({bestOffer.size})</span>
              {bestOffer.parties.length > 1 ? <span className="mk-muted"> (+{bestOffer.parties.length - 1})</span> : null}
              <span className="mk-code"> {bestOffer.parties[0]?.code ?? "—"}</span>
            </>
          ) : <span className="mk-muted">— — —</span>}
        </button>

        {/* Lift-offer IOC */}
        <button
          type="button" className="mk-book__hit"
          disabled={!bestOffer || !send}
          onClick={() => {
            if (!bestOffer || !send) return;
            send({
              type: "PLACE_IOC", contractId, side: "buy",
              price: bestOffer.price, qty: Number(hitQty) || 1,
            });
          }}
          title="Lift best offer (IOC buy)"
        >Lift</button>
      </div>

      {expanded ? <ExpandedLevels book={book} contractId={contractId} /> : null}
    </div>
  );
}

function ExpandedLevels({
  book, contractId,
}: {
  book: ProjectedBook | undefined;
  contractId: ContractId;
}): ReactNode {
  if (!book) return null;
  const rows = Math.max(book.bids.length, book.offers.length, 3);
  return (
    <table className="mk-book__expanded">
      <thead>
        <tr>
          <th>Bid party</th>
          <th>Bid size</th>
          <th>Bid</th>
          <th>Offer</th>
          <th>Offer size</th>
          <th>Offer party</th>
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }).map((_, i) => {
          const b = book.bids[i];
          const o = book.offers[i];
          return (
            <tr key={i}>
              <td className="mk-code">{b?.parties[0]?.code ?? ""}</td>
              <td className="mk-num">{b?.size ?? ""}</td>
              <td className="mk-bid mk-num"
                  onClick={() => b && setSelection({ contractId, side: "sell", price: b.price, qty: b.size })}>
                {b?.price ?? ""}
              </td>
              <td className="mk-offer mk-num"
                  onClick={() => o && setSelection({ contractId, side: "buy", price: o.price, qty: o.size })}>
                {o?.price ?? ""}
              </td>
              <td className="mk-num">{o?.size ?? ""}</td>
              <td className="mk-code">{o?.parties[0]?.code ?? ""}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
