// ============================================================
// Compliance requests: the line left on a conversation or a ticket when a request is raised from it. Pure; browser-safe.
//
// "Compliance request CMP-2026-000014 raised" is an internal note, so everyone who can open the conversation or the ticket reads it. It carries the
// reference and nothing else. The screen turns the reference into a link to the Compliance list only for a person who holds the Compliance menu.
// ============================================================

const NOTE_RE = /^Compliance request (CMP-\d{4}-\d{6,}) raised$/;

/** The text of the note. */
export const raisedNoteText = (reference: string): string => `Compliance request ${reference} raised`;

/** The reference a note is about, or null when the text is not such a note. */
export function raisedNoteReference(text: string | null | undefined): string | null {
  return NOTE_RE.exec((text ?? "").trim())?.[1] ?? null;
}

/** Where the link goes: the Compliance list, searched for that reference. */
export const raisedNoteHref = (reference: string): string => `/compliance?q=${encodeURIComponent(reference)}`;
