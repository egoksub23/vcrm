// ============================================================
// Doc Sign, browser side: everything that stands between a draft and "Send", gathered for the review step:
// what `sendProblems` finds in the draft as it is on screen, what the draft's options as typed would be
// refused for, and what the server last said. Pure and tested.
// ============================================================

import { sendProblems } from "../rules";
import type { SignRole } from "../types";
import type { PlacedField } from "../pdf/types";
import type { SignIssue } from "./api";
import { optionsFlags, type DraftOptions } from "./draft-options";
import { dedupeIssues, problemKey } from "./errors";
import { toDrafts, type SignerRow } from "./signers-form";

export interface DraftFacts {
  fields: readonly PlacedField[];
  roles: readonly SignRole[];
  pageCount: number;
  hasBaseFile: boolean;
}

/** The problems with a draft, each once. Without any roles the only news is that fields (which make the roles) are still to place. */
export function draftProblems(args: { facts: DraftFacts; rows: readonly SignerRow[]; options: DraftOptions; serverProblems?: readonly SignIssue[]; now: Date }): SignIssue[] {
  const { facts, rows, options, now } = args;
  if (facts.roles.length === 0) {
    return [...(facts.hasBaseFile ? [] : [{ code: "no_file" }]), { code: "no_roles" }];
  }
  const found: SignIssue[] = sendProblems({
    fields: facts.fields,
    roles: facts.roles,
    signers: toDrafts(rows, facts.roles),
    signInOrder: options.signInOrder,
    pageCount: facts.pageCount,
    hasBaseFile: facts.hasBaseFile,
  });
  const flags = optionsFlags(options, now);
  if (flags.title) found.push({ code: "title_required" });
  if (flags.message) found.push({ code: "message_long" });
  if (flags.expiryPast) found.push({ code: "expiry_past" });
  if (flags.reminders) found.push({ code: "reminders_bad" });
  return dedupeIssues([...found, ...(args.serverProblems ?? [])]);
}

/** Layout problems (fields that are off the page, a role with a bad name...) are many and mean "open the editor": they read as one line. */
export function splitLayoutIssues(issues: readonly SignIssue[]): { single: SignIssue[]; layoutCount: number } {
  const single: SignIssue[] = [];
  let layoutCount = 0;
  for (const i of issues) {
    if (problemKey(i.code) === "problems.layout") layoutCount += 1;
    else single.push(i);
  }
  return { single, layoutCount };
}
