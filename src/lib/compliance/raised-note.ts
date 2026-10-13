// ============================================================
// Compliance requests: the lines left on a conversation or a ticket about a request. Pure; browser-safe.
//
//   "Compliance request CMP-2026-000014 raised"            when an agent raises a request from it (migration 184)
//   "Closure form submitted · CMP-2026-000014"             when the customer fills in the personal closure form sent in the chat (migration 185)
//
// Both are internal notes, so everyone who can open the conversation or the ticket reads them. They carry the reference and nothing else. The screen
// turns the reference into a link to the Compliance list only for a person who holds the Compliance menu.
// ============================================================

const NOTE_RE = /^(?:Compliance request (CMP-\d{4}-\d{6,}) raised|Closure form submitted · (CMP-\d{4}-\d{6,}))$/;

/** The text of the note. */
export const raisedNoteText = (reference: string): string => `Compliance request ${reference} raised`;

/** The text of the note about a personal closure form that came back. */
export const formSubmittedNoteText = (reference: string): string => `Closure form submitted · ${reference}`;

/** The reference a note is about, or null when the text is not such a note. */
export function raisedNoteReference(text: string | null | undefined): string | null {
  const m = NOTE_RE.exec((text ?? "").trim());
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** Where the link goes: the Compliance list, searched for that reference. */
export const raisedNoteHref = (reference: string): string => `/compliance?q=${encodeURIComponent(reference)}`;
