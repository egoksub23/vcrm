// ============================================================
// JQL for the "Link existing issue" search box. Pure.
//
// The user's text is escaped into a JQL string literal; it can never add a
// clause, and Jira's wildcard characters are stripped from the text search.
// ============================================================

import { parseIssueRef } from "./create-issue";

/** A JQL string literal: quotes and backslashes escaped, control characters dropped. */
export function jqlString(s: string): string {
  return `"${s.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The JQL for a search-box entry, limited to the allowed projects when there are some. */
export function buildSearchJql(text: string, allowedProjects: readonly string[]): string {
  const t = text.trim().slice(0, 120);
  const ref = parseIssueRef(t);
  const clauses: string[] = [];
  if (ref) clauses.push(`key = ${jqlString(ref.key)}`);
  const words = t.replace(/[^\p{L}\p{N}\s._-]/gu, " ").replace(/\s+/g, " ").trim();
  if (words) clauses.push(`text ~ ${jqlString(words)}`);
  const match = clauses.length ? `(${clauses.join(" OR ")})` : "";
  const scope = allowedProjects.length ? `project in (${allowedProjects.map((k) => jqlString(k)).join(", ")})` : "";
  const where = [scope, match].filter(Boolean).join(" AND ");
  return `${where || "updated >= -30d"} ORDER BY updated DESC`;
}
