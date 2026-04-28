// =============================================================================
// OrderPlacer — limit / IOC orders. Auto-populates from clicks in
// other modules via `workspaceStore.useSelection`.
// =============================================================================

import { useEffect, useState, type ReactNode } from "react";
import type { ProjectedSnapshot } from "../../engine/project";
import type { ContractId } from "../../shared/ids";
import type { OrderSide } from "../../shared/types";
import { useSelection } from "../workspaceStore";

interface Props {
  readonly snapshot: ProjectedSnapshot;
  send(msg: unknown): void;
}

export function OrderPlacer({ snapshot, send }: Props): ReactNode {
  const sel = useSelection();
  const [contractId, setContractId] = useState<ContractId | null>(null);
  const [side, setSide] = useState<OrderSide>("buy");
  const [price, setPrice] = useState<string>("");
  const [qty, setQty] = useState<string>("");
  const [type, setType] = useState<"limit" | "ioc">("limit");

  // Sync contract default to first available
  useEffect(() => {
    if (!contractId && snapshot.contracts.length > 0) {
      setContractId(snapshot.contracts[0]!.id);
    }
  }, [contractId, snapshot.contracts]);

  // Apply selection updates
  useEffect(() => {
    if (sel.contractId) setContractId(sel.contractId);
    if (sel.side) setSide(sel.side);
    if (sel.price !== null) setPrice(String(sel.price));
    if (sel.qty !== null) setQty(String(sel.qty));
  }, [sel.contractId, sel.side, sel.price, sel.qty]);

  const submit = (): void => {
    if (!contractId) return;
    const numPrice = Number(price);
    const numQty = Number(qty);
    if (!Number.isInteger(numPrice) || !Number.isInteger(numQty) || numQty <= 0) return;
    send({
      type: type === "ioc" ? "PLACE_IOC" : "PLACE_LIMIT",
      contractId, side, price: numPrice, qty: numQty,
    });
    setPrice("");
    setQty("");
  };

  return (
    <div className="mk-placer">
      <select value={contractId ?? ""} onChange={(e) => setContractId(e.target.value as ContractId)}>
        {snapshot.contracts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>

      <div className="mk-placer__seg">
        <button
          type="button"
          className={`mk-button ${side === "buy" ? "mk-button--primary" : ""}`}
          onClick={() => setSide("buy")}
        >Buy</button>
        <button
          type="button"
          className={`mk-button ${side === "sell" ? "mk-button--primary" : ""}`}
          onClick={() => setSide("sell")}
        >Sell</button>
      </div>

      <input
        className="mk-placer__price" type="number" placeholder="Price"
        value={price} onChange={(e) => setPrice(e.target.value)}
      />
      <input
        className="mk-placer__qty" type="number" placeholder="Qty"
        value={qty} onChange={(e) => setQty(e.target.value)}
      />

      <div className="mk-placer__seg">
        <button
          type="button"
          className={`mk-button ${type === "limit" ? "mk-button--primary" : ""}`}
          onClick={() => setType("limit")}
        >Limit</button>
        <button
          type="button"
          className={`mk-button ${type === "ioc" ? "mk-button--primary" : ""}`}
          onClick={() => setType("ioc")}
        >IOC</button>
      </div>

      <button
        type="button" className="mk-button mk-button--primary mk-button--large"
        onClick={submit}
        disabled={!contractId || !price || !qty}
      >
        {side === "buy" ? "Buy" : "Sell"}{qty ? ` ${qty}` : ""}{price ? ` @ ${price}` : ""}
      </button>
    </div>
  );
}
