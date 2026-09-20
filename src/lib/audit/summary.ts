// ============================================================
// Turn `audit_log.summary` (small jsonb written by the triggers) into a
// list of structured parts. The screen renders each part with i18n; the
// CSV export renders the same parts as plain text. Pure, no I/O.
//
// Shapes written by migration 082:
//   { changes: { <col>: { from, to } } }   scalar fields (name, colour…)
//   { changed: [<col>, …] }                names only (text, secrets)
//   { values: { <col>: v } }               a creation
//   { published: true }                    article published
//   { language }                           a translation of an article
//   { label | tag, tag_id }                label / tag applied or removed
//   { from, to }                           role changed
//   { capability, from, to }               capability switched
//   { role }                               invitation
//   { member, user_id }                    team member added / removed
//   { contacts_untagged, conversations_unlabelled }  tag deleted
//   { self, role }                         member left / removed
// ============================================================

export type SummaryPart =
  | { type: "renamed"; from: string; to: string }
  | { type: "changed"; field: string; from: string; to: string }
  | { type: "edited"; fields: string[] }
  | { type: "published" }
  | { type: "language"; language: string }
  | { type: "tagApplied"; name: string }
  | { type: "roleChange"; from: string; to: string }
  | { type: "capability"; capability: string; granted: boolean }
  | { type: "invitedRole"; role: string }
  | { type: "person"; name: string }
  | { type: "untagged"; contacts: number; conversations: number }
  | { type: "left" };

/** Columns whose change is a rename. */
const NAME_FIELDS = new Set(["name", "title"]);

function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return "";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function describeSummary(
  action: string,
  summary: Record<string, unknown> | null | undefined,
): SummaryPart[] {
  if (!isRecord(summary)) return [];
  const parts: SummaryPart[] = [];

  if (action === "role_changed") {
    parts.push({ type: "roleChange", from: str(summary.from), to: str(summary.to) });
    return parts;
  }
  if (action === "capability_changed") {
    parts.push({
      type: "capability",
      capability: str(summary.capability),
      granted: summary.to === true,
    });
    return parts;
  }
  if (action === "invited") {
    if (summary.role) parts.push({ type: "invitedRole", role: str(summary.role) });
    return parts;
  }
  if (action === "member_removed") {
    if (summary.self === true) parts.push({ type: "left" });
    return parts;
  }
  if (action === "team_member_added" || action === "team_member_removed") {
    if (summary.member) parts.push({ type: "person", name: str(summary.member) });
    return parts;
  }
  if (action === "applied" || action === "removed") {
    const name = str(summary.label ?? summary.tag);
    if (name) parts.push({ type: "tagApplied", name });
    return parts;
  }

  if (summary.published === true) parts.push({ type: "published" });

  if (typeof summary.language === "string" && summary.language) {
    parts.push({ type: "language", language: summary.language });
  }

  const changes = summary.changes;
  if (isRecord(changes)) {
    for (const [field, change] of Object.entries(changes)) {
      if (!isRecord(change)) continue;
      const from = str(change.from);
      const to = str(change.to);
      if (NAME_FIELDS.has(field)) parts.push({ type: "renamed", from, to });
      else parts.push({ type: "changed", field, from, to });
    }
  }

  if (Array.isArray(summary.changed) && summary.changed.length > 0) {
    parts.push({ type: "edited", fields: summary.changed.map(str).filter(Boolean) });
  }

  const contacts = Number(summary.contacts_untagged ?? 0);
  const conversations = Number(summary.conversations_unlabelled ?? 0);
  if (action === "deleted" && (contacts > 0 || conversations > 0)) {
    parts.push({ type: "untagged", contacts, conversations });
  }

  return parts;
}

/** Plain English, for the CSV export (the screen uses i18n instead). */
export function summaryToText(
  action: string,
  summary: Record<string, unknown> | null | undefined,
): string {
  return describeSummary(action, summary)
    .map((p): string => {
      switch (p.type) {
        case "renamed":
          return `renamed "${p.from}" to "${p.to}"`;
        case "changed":
          return `${p.field}: "${p.from}" to "${p.to}"`;
        case "edited":
          return `changed ${p.fields.join(", ")}`;
        case "published":
          return "published";
        case "language":
          return `language ${p.language}`;
        case "tagApplied":
          return `"${p.name}"`;
        case "roleChange":
          return `${p.from} to ${p.to}`;
        case "capability":
          return `${p.capability} ${p.granted ? "granted" : "revoked"}`;
        case "invitedRole":
          return `as ${p.role}`;
        case "person":
          return p.name;
        case "untagged":
          return `removed from ${p.contacts} contacts and ${p.conversations} conversations`;
        case "left":
          return "left the workspace";
      }
    })
    .join("; ");
}
