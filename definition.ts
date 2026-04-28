// =============================================================================
// Mockery — GameDefinition exported to the In My Pocket platform.
//
// Authoritative spec: docs/game-spec.md
// =============================================================================

import { asGameId, type GameDefinition } from "./shared";
import {
  createFromOpts,
  loadFromOpts,
  type MockerySave,
} from "./server/MockerySession";
import { normalizeMockeryOptions } from "./server/options";

export const def: GameDefinition<MockerySave> = {
  id: asGameId("mockery"),
  displayName: "Mockery",
  // Default scenario: 6 informed + 0 uninformed. The platform's
  // current seam treats min/max as fixed counts; we expose those
  // derived from informedSeats + uninformedSeats. See game-spec §10.1.
  minPlayers: 6,
  maxPlayers: 6,
  supportsSpectators: true,
  optionsSchema: [
    { kind: "number",  key: "informedSeats",     label: "Informed seats",      default: 6,  min: 1, max: 26 },
    { kind: "number",  key: "uninformedSeats",   label: "Uninformed seats",    default: 0,  min: 0, max: 26 },
    { kind: "number",  key: "publicSlots",       label: "Public hidden cards", default: 3,  min: 0, max: 20 },
    { kind: "number",  key: "copiesPerValue",    label: "Copies per value",    default: 4,  min: 1, max: 12 },
    { kind: "string",  key: "cardValuesCsv",     label: "Card values (CSV)",   default: "1,2,9,10" },
    { kind: "enum",    key: "eventMode",         label: "Event mode",          default: "auto",  choices: ["auto", "manual"] },
    { kind: "number",  key: "eventIntervalMin",  label: "Event interval min (sec)", default: 300, min: 1 },
    { kind: "number",  key: "eventIntervalMax",  label: "Event interval max (sec)", default: 480, min: 1 },
    { kind: "number",  key: "endGameGraceSec",   label: "End-game grace (sec, manual)", default: 0,   min: 0 },
    { kind: "enum",    key: "codeMode",          label: "Participant code mode", default: "alpha", choices: ["alpha", "random"] },
    { kind: "boolean", key: "enforceCaseByRole", label: "Enforce case (uppercase=informed)", default: false },
    { kind: "enum",    key: "identityReveal",    label: "Reveal name↔code mapping to", default: "all", choices: ["all", "host", "listed"] },
    { kind: "number",  key: "seed",              label: "Random seed (0 = pick one for me)", default: 0 },
  ],
  normalizeOptions(options) {
    return normalizeMockeryOptions(options);
  },
  createSession(opts) {
    return createFromOpts(opts);
  },
  loadSession(blob, opts) {
    return loadFromOpts(blob, opts);
  },
};
