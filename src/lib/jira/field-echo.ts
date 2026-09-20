// ============================================================
// Custom-field echo guard (server only: hashing needs node:crypto).
//
// The link remembers, per mapped field, a hash of the value last pushed to or
// applied from Jira (`vircle`) and of the value last seen in Jira (`jira`).
// Nothing but hashes is stored. See field-mapping.ts for the conversions.
// ============================================================

import { createHash } from "node:crypto";

import type { Norm } from "./field-mapping";
import type { FieldState } from "./types";

/** A stable hash of a normalised value (the echo memory holds hashes, never values). */
export function hashNorm(v: Norm): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 24);
}

// ------------------------------------------------------------
// Echo decisions (pure)
// ------------------------------------------------------------

/** Vircle -> Jira: does this ticket value need to be pushed? (Only what changed since the last push/apply.) */
export function decidePush(state: FieldState | undefined, norm: Norm): "push" | "unchanged" {
  return state?.vircle !== undefined && state.vircle === hashNorm(norm) ? "unchanged" : "push";
}

export type PullDecision =
  | { kind: "seed" }
  | { kind: "unchanged" }
  /** The change is our own push coming back (or already equals the ticket). */
  | { kind: "echo" }
  | { kind: "apply" };

/**
 * Jira -> Vircle: what to do with the value Jira has now.
 *  - no memory yet: remember it (existing values are recorded as seen, not imported)
 *  - equals what we saw last time: nothing changed in Jira
 *  - equals what we last wrote / what the ticket already holds: our own echo
 *  - else Jira changed it: apply (Jira wins, like status)
 */
export function decidePull(state: FieldState | undefined, jiraNorm: Norm): PullDecision {
  const h = hashNorm(jiraNorm);
  if (!state || (state.jira === undefined && state.vircle === undefined)) return { kind: "seed" };
  if (state.jira === h) return { kind: "unchanged" };
  if (state.vircle === h) return { kind: "echo" };
  return { kind: "apply" };
}

