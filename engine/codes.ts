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

/** Generate a fresh code book from scratch.
 *
 *  alpha mode: derive from displayName initials, bumping on collision.
 *  random mode: deterministic shuffle of 2-letter pairs from the seeded RNG.
 *
 *  Throws if there are too many participants for the alphabet (< 26 ✓).
 */
export function generateCodeBook(
  participants: readonly ParticipantInfo[],
  opts: GenerateOptions,
): CodeBook {
  if (participants.length > ALPHABET.length) {
    throw new Error(
      `too many participants (${participants.length}) for 2-letter code book`,
    );
  }

  const out: CodeBook = {};
  if (opts.mode === "random") {
    const shuffled = shuffle(ALPHABET, opts.rng);
    for (let i = 0; i < participants.length; i++) {
      const p = participants[i]!;
      const seed1 = shuffled[i]!;
      // pair the seed letter with another picked from the rest, also
      // shuffled. To keep the pairing simple and unique, we pick the
      // letter at offset (i + 1) mod 26 from the same shuffled array.
      const seed2 = shuffled[(i + 1) % shuffled.length]!;
      const raw = seed1 + seed2;
      out[participantKey(p.id)] = applyCase(raw, p, opts.enforceCaseByRole);
    }
    // resolve collisions by bumping
    fixCollisions(out, participants, opts.enforceCaseByRole);
    return out;
  }

  // alpha mode: derive from display name initials.
  for (const p of participants) {
    const raw = initialsFromName(p.displayName);
    out[participantKey(p.id)] = applyCase(raw, p, opts.enforceCaseByRole);
  }
  fixCollisions(out, participants, opts.enforceCaseByRole);
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

/** In-place collision repair: walks participants in order, bumps the
 *  second letter A→B→C... and wraps around the alphabet. Falls back to
 *  bumping the first letter if the second exhausts. Throws if no unique
 *  code can be found (effectively impossible for ≤ 26 participants). */
function fixCollisions(
  book: CodeBook,
  participants: readonly ParticipantInfo[],
  enforceCaseByRole: boolean,
): void {
  for (let i = 0; i < participants.length; i++) {
    const p = participants[i]!;
    const myKey = participantKey(p.id);
    let code = book[myKey]!;

    let attempts = 0;
    while (collides(code, myKey, book)) {
      code = bump(code, attempts);
      code = applyCase(code, p, enforceCaseByRole);
      attempts++;
      if (attempts > 26 * 26) {
        throw new Error("could not resolve code collision");
      }
    }
    book[myKey] = code;
  }
}

function collides(code: string, myKey: string, book: CodeBook): boolean {
  for (const [key, other] of Object.entries(book)) {
    if (key === myKey) continue;
    if (codesCollide(code, other)) return true;
  }
  return false;
}

function bump(code: string, attempt: number): string {
  // Increment the second letter by 1 each attempt; on overflow bump
  // first letter and reset second.
  const a = code.charCodeAt(0);
  const b = code.charCodeAt(1);
  const isUpper = a >= 65 && a <= 90;
  const base = isUpper ? 65 : 97;
  const offset = (b - base + 1) % 26;
  if (offset === 0) {
    const newA = base + ((a - base + 1) % 26);
    return String.fromCharCode(newA, base + offset);
  }
  return String.fromCharCode(a, base + offset);
}
