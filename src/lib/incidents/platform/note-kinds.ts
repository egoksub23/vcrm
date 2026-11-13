// The kinds of note on an incident (migration 230). An ordinary note has no kind. Pure.

export const NOTE_KINDS = ["investigation", "finding", "closing"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export function isNoteKind(v: unknown): v is NoteKind {
  return typeof v === "string" && (NOTE_KINDS as readonly string[]).includes(v);
}

/** A note's kind, reading the older yes/no `is_finding` when the kind itself was never set. */
export function kindOf(note: { kind?: string | null; is_finding?: boolean | null }): NoteKind | null {
  if (isNoteKind(note.kind)) return note.kind;
  return note.is_finding ? "finding" : null;
}

export interface NoteLike {
  body: string;
  created_at: string;
  kind?: string | null;
  is_finding?: boolean | null;
}

/**
 * What the incident concludes, in the order a reader wants it: the closing note, then the findings, then the investigation notes as they happened. Used by
 * the Conclusions panel and by the report for filing, so both say the same thing in the same order.
 */
export function conclusionsOf<T extends NoteLike>(notes: readonly T[]): { closing: T[]; findings: T[]; investigation: T[] } {
  const byTime = [...notes].sort((a, b) => a.created_at.localeCompare(b.created_at));
  return {
    closing: byTime.filter((n) => kindOf(n) === "closing"),
    findings: byTime.filter((n) => kindOf(n) === "finding"),
    investigation: byTime.filter((n) => kindOf(n) === "investigation"),
  };
}
