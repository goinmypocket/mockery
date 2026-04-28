// =============================================================================
// Tiny cross-module store: the user clicks on something in the Order Book
// or TNS, and the Order Placer reacts. Implementation is a plain
// useSyncExternalStore adapter (no zustand dep).
// =============================================================================

import { useSyncExternalStore } from "react";
import type { ContractId } from "../shared/ids";
import type { OrderSide } from "../shared/types";

export interface Selection {
  contractId: ContractId | null;
  side: OrderSide | null;
  price: number | null;
  qty: number | null;
}

const initial: Selection = { contractId: null, side: null, price: null, qty: null };

let state: Selection = initial;
const listeners = new Set<() => void>();

export function setSelection(next: Partial<Selection>): void {
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

export function useSelection(): Selection {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => state,
    () => state,
  );
}
