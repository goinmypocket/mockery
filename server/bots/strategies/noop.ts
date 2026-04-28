// =============================================================================
// "noop" strategy — does nothing. Useful as a template and as the
// default strategy for unbound bot entities.
// =============================================================================

import type { BotStrategy } from "../api";

const noop: BotStrategy = {
  id: "noop",
  displayName: "No-op (does nothing)",
};

export default noop;
