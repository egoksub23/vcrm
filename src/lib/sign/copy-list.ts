// ============================================================
// People who RECEIVE A COPY, as a ready-made list (migration 176): the list a bulk send or a registration form carries and puts on every document it
// makes. Pure (no I/O) and shared by the server and the screens, so the one definition of a good list is in one place:
//
//   - at most 10 people (the same limit as one document: MAX_COPY_RECIPIENTS),
//   - each a name of 1 to 160 characters and an address that looks like one (the check a signer's address gets), at most 254 characters,
//   - each address once, case and spaces ignored.
//
// The database holds the same rules (sign_copy_list_valid); this is what answers a person with a reason before it gets there.
// ============================================================

import { MAX_COPY_RECIPIENTS } from "./envelopes/people";

export { MAX_COPY_RECIPIENTS };

/** A person who receives the signed copy. */
export interface CopyInput {
  fullName: string;
  email: string;
}

export const COPY_NAME_MAX = 160;
export const COPY_EMAIL_MAX = 254;
export const COPY_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Why a list is refused: a code the screens word (the same codes the copies routes use), and which person (0-based) when it is about one. */
export interface CopyListIssue {
  code: "copy_name" | "copy_email" | "copy_duplicate" | "too_many_copies" | "bad_copy_list";
  index?: number;
}

export type CopyListCheck = { ok: true; list: CopyInput[] } | { ok: false; issues: CopyListIssue[] };

/** The first thing wrong with one person, or null. */
export function copyProblem(input: { fullName?: unknown; email?: unknown }): "copy_name" | "copy_email" | null {
  const name = typeof input.fullName === "string" ? input.fullName.trim() : "";
  const email = typeof input.email === "string" ? input.email.trim() : "";
  if (!name || name.length > COPY_NAME_MAX) return "copy_name";
  if (!COPY_EMAIL_RE.test(email) || email.length > COPY_EMAIL_MAX) return "copy_email";
  return null;
}

/**
 * A list as a request carries it: `[{ fullName, email }]` (`full_name` is taken too). Names and addresses are trimmed; the problems of every person
 * are listed, not only the first. An empty list is a good list (no copies).
 */
export function checkCopyList(raw: unknown): CopyListCheck {
  if (raw === undefined || raw === null) return { ok: true, list: [] };
  if (!Array.isArray(raw)) return { ok: false, issues: [{ code: "bad_copy_list" }] };
  const issues: CopyListIssue[] = [];
  if (raw.length > MAX_COPY_RECIPIENTS) issues.push({ code: "too_many_copies" });
  const list: CopyInput[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const o = (typeof item === "object" && item !== null && !Array.isArray(item) ? item : {}) as Record<string, unknown>;
    const person = { fullName: o.fullName ?? o.full_name, email: o.email };
    const problem = copyProblem(person);
    if (problem) return void issues.push({ code: problem, index });
    const clean = { fullName: (person.fullName as string).trim(), email: (person.email as string).trim() };
    const key = clean.email.toLowerCase();
    if (seen.has(key)) return void issues.push({ code: "copy_duplicate", index });
    seen.add(key);
    list.push(clean);
  });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, list };
}

/**
 * The people of a list who are not on a document's signing list (a signer gets the signed copy anyway, and the database refuses the same person as
 * both), in the order of the list. Addresses are compared with case and spaces ignored.
 */
export function copiesWithoutSigners(list: readonly CopyInput[], signerEmails: Iterable<string>): CopyInput[] {
  const signing = new Set([...signerEmails].map((e) => e.trim().toLowerCase()).filter(Boolean));
  return list.filter((c) => !signing.has(c.email.trim().toLowerCase()));
}
