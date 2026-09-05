// =============================================================================
// Code book — generation and validation. See docs/game-spec.md §11.
//
// Pure functions; the reducer is the only place that mutates state.
// =============================================================================

import type {
  CodeBook,
  CodeMode,
  ParticipantCode,
  ParticipantId,
} from "../shared/types";
import {
  codesCollide,
  isValidCode,
  participantKey,
} from "../shared/types";
import { shuffle, type Rng } from "./rng";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
const MAX_CODES = ALPHABET.length * ALPHABET.length;  // 676 two-letter codes

export interface ParticipantInfo {
  readonly id: ParticipantId;
  readonly displayName: string;
  /** Whether this participant counts as informed (case forced uppercase
   *  when enforceCaseByRole is on). Bots are never informed. */
  readonly informed: boolean;
}

export interface GenerateOptions {
  readonly mode: CodeMode;
  readonly enforceCaseByRole: boolean;
  readonly rng: Rng;            // mutated for `random` mode
}

/** Generate a fresh code book.
 *
 *  alpha mode: derive codes from displayName initials.
 *  random mode: deterministic shuffle of all 2-letter pairs.
 *
 *  Initials are only a preference: players (including guests with identical
 *  names) and bots advance to the next free code on collision.
 */
export function generateCodeBook(
  participants: readonly ParticipantInfo[],
  opts: GenerateOptions,
): CodeBook {
  if (participants.length > MAX_CODES) {
    throw new Error(
      `too many participants (${participants.length}) for 2-letter code book`,
    );
  }

  const out: CodeBook = {};
  const used = new Set<string>();

  if (opts.mode === "random") {
    const pairs: string[] = [];
    for (const a of ALPHABET) for (const b of ALPHABET) pairs.push(a + b);
    const shuffled = shuffle(pairs, opts.rng);
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i]!;
      const code = applyCase(shuffled[i]!, p, opts.enforceCaseByRole);
      out[participantKey(p.id)] = code;
      used.add(code.toLowerCase());
    }
    return out;
  }

  for (const p of participants) {
    let code = applyCase(initialsFromName(p.displayName), p, opts.enforceCaseByRole);
    if (used.has(code.toLowerCase())) {
      code = nextAvailable(used, p, opts.enforceCaseByRole, code);
    }
    out[participantKey(p.id)] = code;
    used.add(code.toLowerCase());
  }
  return out;
}

/** Validate a single host-supplied override.  Returns ok or an error
 *  reason. Used by the reducer for SETUP_SET_CODE. */
export function validateCode(
  code: string,
  participant: ParticipantInfo,
  enforceCaseByRole: boolean,
  existing: CodeBook,
): { ok: true } | { ok: false; reason: string } {
  if (!isValidCode(code)) {
    return { ok: false, reason: "code must be exactly 2 ASCII letters" };
  }
  if (enforceCaseByRole) {
    const expected = participant.informed ? code.toUpperCase() : code.toLowerCase();
    if (code !== expected) {
      return {
        ok: false,
        reason: participant.informed
          ? "informed participants require uppercase codes"
          : "uninformed participants require lowercase codes",
      };
    }
  }
  const myKey = participantKey(participant.id);
  for (const [key, other] of Object.entries(existing)) {
    if (key === myKey) continue;
    if (codesCollide(code, other)) {
      return { ok: false, reason: `code collides with ${other}` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function initialsFromName(name: string): string {
  const letters = name.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (letters.length >= 2) return letters.slice(0, 2);
  if (letters.length === 1) return letters + "X";
  return "XX";
}

function applyCase(
  raw: string,
  p: ParticipantInfo,
  enforceCaseByRole: boolean,
): ParticipantCode {
  if (!enforceCaseByRole) return raw;
  return p.informed ? raw.toUpperCase() : raw.toLowerCase();
}

function nextAvailable(
  used: Set<string>,
  p: ParticipantInfo,
  enforceCaseByRole: boolean,
  preferred: string,
): string {
  const upper = preferred.toUpperCase();
  const start = ALPHABET.indexOf(upper[0]!) * ALPHABET.length + ALPHABET.indexOf(upper[1]!);
  for (let offset = 1; offset <= MAX_CODES; offset++) {
    const index = (start + offset) % MAX_CODES;
    const raw = ALPHABET[Math.floor(index / ALPHABET.length)]! + ALPHABET[index % ALPHABET.length]!;
    const code = applyCase(raw, p, enforceCaseByRole);
    if (!used.has(code.toLowerCase())) return code;
  }
  throw new Error("no available 2-letter code");
}
