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
  // The platform reads min/max once at registration, so they're a
  // static range. The session enforces the *exact* options-driven
  // headcount (`informedSeats + uninformedSeats`) at START_TRADING.
  // The lobby may briefly show empty seats beyond the chosen
  // headcount; they're ignored.
  minPlayers: 2,
  maxPlayers: 8,
  supportsSpectators: true,
  // Only seat-count knobs are set up-front: they affect how the platform
  // allocates lobby seats and whether each seat is informed or uninformed.
  // Every other option (deck, event timing, codes, identity reveal, etc.)
  // is edited by the host in the setup phase, AFTER players have joined.
  optionsSchema: [
    { kind: "number", key: "informedSeats",   label: "Informed seats",   default: 2, min: 1, max: 8 },
    { kind: "number", key: "uninformedSeats", label: "Uninformed seats", default: 0, min: 0, max: 8 },
    { kind: "number", key: "seed",            label: "Random seed (0 = pick one for me)", default: 0 },
  ],
  normalizeOptions(options) {
    return normalizeMockeryOptions(options);
  },
  savedParticipants(blob) {
    return blob.seats.flatMap((userId, seatIndex) => userId ? [{ seatIndex, userId, displayName: blob.seatDisplayNames[seatIndex] ?? "Player" }] : []);
  },
  createSession(opts) {
    return createFromOpts(opts);
  },
  loadSession(blob, opts) {
    return loadFromOpts(blob, opts);
  },
};
