// =============================================================================
// "noop" strategy — does nothing. Useful as a template and as the
// default strategy for unbound bot entities.
// =============================================================================

import { NOOP_METADATA } from "../../../shared/botStrategies";
import type { BotStrategy } from "../api";

const noop: BotStrategy = {
  ...NOOP_METADATA,
};

export default noop;
