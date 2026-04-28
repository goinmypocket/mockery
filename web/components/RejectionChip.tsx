import type { ReactNode } from "react";

export function RejectionChip({
  text, onDismiss,
}: {
  text: string;
  onDismiss(): void;
}): ReactNode {
  return (
    <button type="button" className="mk-rejection" onClick={onDismiss} title="Dismiss">
      ⚠ {text} ×
    </button>
  );
}
