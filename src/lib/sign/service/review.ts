// ============================================================
// The signer's last look: the answers as they will be printed on the document, and any answer that does not
// fit where it is printed. Everything is the shared module's (boundValues, fitProblems, signReady); this only
// gathers the document's answers, of every role, and keeps the signer from a review before their parts are done.
// ============================================================

import { boundPlacements, boundValues, fitProblems } from "../forms";
import type { PrintedValue, ReviewResult } from "../forms/api-types";
import { isDelegate } from "../forward";
import { getFile } from "../storage";
import type { SignCtx } from "./context";
import { SignError } from "./errors";
import { formOf, loadFormState, missingFor, readyFor } from "./form-state";
import { assertConsented, assertOpen, type Lookup } from "./signing";

export async function reviewFor(ctx: SignCtx, lookup: Lookup): Promise<ReviewResult> {
  assertOpen(lookup);
  assertConsented(lookup);
  const { doc, signer } = lookup;
  const form = formOf(doc);
  if (!form) return { printed: {}, fitProblems: [] };
  // the whole document's answers are printed here: a person handed one part of it sees that part and nothing more
  if (isDelegate(signer)) throw new SignError("forbidden", "You do not have access to this.", 403);

  const { state, signers } = await loadFormState(ctx, doc, form);
  if (!readyFor(form, signer, state, signers)) {
    throw new SignError(
      "form_incomplete",
      "Answer every required question before you review.",
      409,
      missingFor(form, signer, state.map).map((f) => ({ code: "missing_required", field: f.key })),
    );
  }

  const values = boundValues(doc.fields_snapshot, form, state.map, doc.locale);
  const printed: Record<string, PrintedValue> = {};
  for (const [key, v] of Object.entries(values)) {
    if (v.text !== undefined) printed[key] = { text: v.text };
    else if (v.checked !== undefined) printed[key] = { checked: v.checked };
    // pictures are not previewed
  }

  let problems: ReviewResult["fitProblems"] = [];
  if (doc.base_path && boundPlacements(doc.fields_snapshot).length > 0) {
    const base = await getFile(ctx.admin, doc.base_path, ctx.accountId);
    problems = await fitProblems(base, doc.fields_snapshot, form, state.map, doc.locale);
  }
  return { printed, fitProblems: problems };
}
