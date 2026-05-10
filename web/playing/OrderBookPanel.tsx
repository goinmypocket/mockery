// =============================================================================
// OrderBookPanel — one row per contract, laid out as a fixed-column
// table. Click a cell to populate the Order Placer; Hit/Lift buttons
// fire IOC market orders against best bid / best offer. Levels that
// contain the viewer's own resting orders show a small × that
// cancels them.
// =============================================================================

import { useMemo, useRef, useState, type ReactNode } from "react";
import type { ProjectedSnapshot, ProjectedBook, ProjectedLevel } from "../../engine/project";
import type { ContractId, OrderId } from "../../shared/ids";
import type { OrderSide, ParticipantCode } from "../../shared/types";
import { setSelection } from "../workspaceStore";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
}

/** Key derived from (contractId, side, price) so we can look up which
 *  of the viewer's orders rest at any given level in the book. */
type LevelKey = string;
function levelKey(contractId: ContractId, side: OrderSide, price: number): LevelKey {
  return `${contractId}|${side}|${price}`;
}

/** Which party should headline a level. If the viewer is themselves
 *  resting at this level, surface them first so they can see "I am
 *  here" at a glance regardless of price-time priority. Otherwise
 *  fall back to the natural first-in-list party. The bracketed +N
 *  count reflects everyone *other than* the headliner. */
function primaryParty(
  parties: ProjectedLevel["parties"] | undefined,
  myCode: ParticipantCode | null,
): { code: ParticipantCode; isMine: boolean; others: number } | null {
  if (!parties || parties.length === 0) return null;
  const mine = myCode ? parties.find((p) => p.code === myCode) : undefined;
  const head = mine ?? parties[0]!;
  return {
    code: head.code,
    isMine: !!mine,
    others: parties.length - 1,
  };
}

/** Render a level's headline party + "(+N)" suffix. Centralises the
 *  "highlight me" logic so every cell that surfaces parties uses the
 *  same shape. */
function PartyBadge({
  parties, myCode,
}: {
  parties: ProjectedLevel["parties"] | undefined;
  myCode: ParticipantCode | null;
}): ReactNode {
  const head = primaryParty(parties, myCode);
  if (!head) return null;
  return (
    <>
      <span className={head.isMine ? "mk-book__party--mine" : undefined}>{head.code}</span>
      {head.others > 0 ? <span className="mk-muted"> (+{head.others})</span> : null}
    </>
  );
}

export function OrderBookPanel({ snapshot, send }: Props): ReactNode {
  // Build a map from (contract, side, price) → list of viewer's order
  // ids resting there, used to render an inline cancel control on
  // levels the viewer is sitting on.
  const myOrdersByLevel = useMemo(() => {
    const map = new Map<LevelKey, OrderId[]>();
    for (const o of snapshot.myOpenOrders) {
      const k = levelKey(o.contractId, o.side, o.price);
      const arr = map.get(k);
      if (arr) arr.push(o.id);
      else map.set(k, [o.id]);
    }
    return map;
  }, [snapshot.myOpenOrders]);

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
            myCode={snapshot.viewer.myCode}
            myOrdersByLevel={myOrdersByLevel}
            send={send}
          />
        ))}
      </tbody>
    </table>
  );
}

/** Depth restored when re-expanding after a manual collapse — keeps
 *  the user's last-chosen "show N levels" preference instead of
 *  always snapping back to a hardcoded default. */
const DEFAULT_EXPAND_DEPTH = 5;

function ContractRows({
  contractId, name, book, myCode, myOrdersByLevel, send,
}: {
  contractId: ContractId;
  name: string;
  book: ProjectedBook | undefined;
  myCode: ParticipantCode | null;
  myOrdersByLevel: ReadonlyMap<LevelKey, readonly OrderId[]>;
  send(msg: unknown): void;
}): ReactNode {
  // `depth` is the number of levels past BBO to show. 0 == collapsed.
  // `lastDepthRef` remembers the user's last positive choice so the
  // chevron toggle restores it instead of always jumping to the
  // default.
  const [depth, setDepth] = useState(0);
  const lastDepthRef = useRef(DEFAULT_EXPAND_DEPTH);
  const expanded = depth > 0;
  const toggleExpanded = (): void => {
    if (depth > 0) { lastDepthRef.current = depth; setDepth(0); }
    else { setDepth(lastDepthRef.current); }
  };
  const setDepthClamped = (raw: number): void => {
    if (!Number.isFinite(raw)) return;
    setDepth(Math.max(0, Math.floor(raw)));
  };
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

  // Cancel all of the viewer's orders resting at a given level.
  const cancelMineAt = (side: OrderSide, price: number | undefined): void => {
    if (price === undefined) return;
    const ids = myOrdersByLevel.get(levelKey(contractId, side, price));
    if (!ids || ids.length === 0) return;
    for (const id of ids) send({ type: "CANCEL_ORDER", orderId: id });
  };
  const myAt = (side: OrderSide, price: number | undefined): readonly OrderId[] | undefined => {
    if (price === undefined) return undefined;
    return myOrdersByLevel.get(levelKey(contractId, side, price));
  };

  return (
    <>
      <tr className="mk-book__row">
        <td className="mk-book__expand">
          <div className="mk-book__expand-stack">
            <button
              type="button" className="mk-button mk-button--small"
              onClick={toggleExpanded}
              title={expanded ? "Collapse" : `Expand (show ${lastDepthRef.current} levels)`}
            >{expanded ? "▾" : "▸"}</button>
            {expanded ? (
              <input
                type="number" min={1}
                className="mk-book__depth"
                value={depth}
                onChange={(e) => setDepthClamped(Number(e.target.value))}
                title="Levels of depth to show beyond best bid/offer"
                aria-label="Order book expansion depth"
              />
            ) : null}
          </div>
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
          <PartyBadge parties={bestBid?.parties} myCode={myCode} />
          {myAt("buy", bestBid?.price) ? (
            <CancelMineBtn onClick={() => cancelMineAt("buy", bestBid?.price)} />
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
          <PartyBadge parties={bestOffer?.parties} myCode={myCode} />
          {myAt("sell", bestOffer?.price) ? (
            <CancelMineBtn onClick={() => cancelMineAt("sell", bestOffer?.price)} />
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
          depth={depth}
          myCode={myCode}
          onBidClick={onBidClick}
          onOfferClick={onOfferClick}
          myAt={myAt}
          cancelMineAt={cancelMineAt}
        />
      ) : null}
    </>
  );
}

function ExpandedLevels({
  book, depth, myCode, onBidClick, onOfferClick, myAt, cancelMineAt,
}: {
  book: ProjectedBook | undefined;
  depth: number;
  myCode: ParticipantCode | null;
  onBidClick(lvl: ProjectedLevel | undefined): void;
  onOfferClick(lvl: ProjectedLevel | undefined): void;
  myAt(side: OrderSide, price: number | undefined): readonly OrderId[] | undefined;
  cancelMineAt(side: OrderSide, price: number | undefined): void;
}): ReactNode {
  if (!book) return null;
  // Skip the best bid/offer — they're already shown in the collapsed
  // row. Start from the second-best level on each side and show the
  // user-chosen number of levels past BBO.
  const bids = book.bids.slice(1, 1 + depth);
  const offers = book.offers.slice(1, 1 + depth);
  const rows = Math.max(bids.length, offers.length);
  if (rows === 0) return null;
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => {
        const b = bids[i];
        const o = offers[i];
        return (
          <tr key={i} className="mk-book__row mk-book__row--level">
            <td />
            <td />
            <td />
            <td className="mk-code mk-book__cell" onClick={() => onBidClick(b)}>
              <PartyBadge parties={b?.parties} myCode={myCode} />
              {myAt("buy", b?.price) ? (
                <CancelMineBtn onClick={() => cancelMineAt("buy", b?.price)} />
              ) : null}
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
              <PartyBadge parties={o?.parties} myCode={myCode} />
              {myAt("sell", o?.price) ? (
                <CancelMineBtn onClick={() => cancelMineAt("sell", o?.price)} />
              ) : null}
            </td>
            <td />
            <td />
          </tr>
        );
      })}
    </>
  );
}

/** Inline × that cancels the viewer's resting orders at a level.
 *  Stops click-propagation so the surrounding cell's "populate placer"
 *  click handler doesn't also fire. */
function CancelMineBtn({ onClick }: { onClick(): void }): ReactNode {
  return (
    <button
      type="button"
      className="mk-book__cancel-mine"
      title="Cancel my order(s) at this level"
      aria-label="Cancel my order at this level"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
    >×</button>
  );
}
