// Finds the @mentions inside a comment that is still being typed, so the box can
// paint them as coloured chips behind the text. A mention counts only when it is
// "@" followed by the exact name of a person or a team (case-insensitive) and then
// the end of the text, whitespace or punctuation, so a half-typed "@Vic" stays plain.

export type HighlightKind = "person" | "team";

export interface HighlightSegment {
  text: string;
  kind: "text" | HighlightKind;
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function highlightMentions(text: string, people: string[], teams: string[]): HighlightSegment[] {
  if (!text) return [];
  const kinds = new Map<string, HighlightKind>();
  for (const name of teams) if (name.trim()) kinds.set(name.trim().toLowerCase(), "team");
  // A person wins over a team with the same name.
  for (const name of people) if (name.trim()) kinds.set(name.trim().toLowerCase(), "person");
  if (kinds.size === 0) return [{ text, kind: "text" }];

  const names = [...kinds.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
  // The "@" must start the text or follow whitespace, like the picker's own trigger.
  const re = new RegExp(`(^|\\s)@(${names.join("|")})(?=$|[\\s.,!?;:)\\]])`, "gi");

  const out: HighlightSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const lead = m[1] ?? "";
    const start = (m.index ?? 0) + lead.length;
    const token = `@${m[2]}`;
    if (start > last) out.push({ text: text.slice(last, start), kind: "text" });
    out.push({ text: token, kind: kinds.get(m[2].toLowerCase()) ?? "person" });
    last = start + token.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), kind: "text" });
  return out;
}
