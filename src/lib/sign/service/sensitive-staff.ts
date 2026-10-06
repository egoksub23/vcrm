// ============================================================
// Sensitive answers (F-47), the staff side. What the sender's screens (the Progress tab, the document detail) are
// given for a sensitive answer is a mask (`•••• 1234`), never the value. A person who needs the value asks for it:
// `revealAnswer` returns it once, after writing a `sensitive_viewed` event (the field and the document, never the value),
// and refuses when the event cannot be recorded. The route is `POST /api/sign/documents/[id]/sensitive` (sign.send)
// with a limit per person; this module is the service behind it.
// ============================================================

import { fieldVisible, maskValue, type DataField, type FormValue, type FormValueView } from "../forms";
import { loadDocument, logEvent, type SignCtx } from "./context";
import { SignError } from "./errors";
import { formOf, loadFormState, toView } from "./form-state";

/** A stored answer as the sender's screen may see it: a sensitive field's value as its mask, any other as `toView` has it. */
export function staffView(field: Pick<DataField, "sensitive">, value: FormValue): FormValueView {
  return field.sensitive === true ? maskValue(value) : toView(value);
}

export interface RevealResult {
  field: string;
  /** The answer in full. Held by the screen for a short while, never stored by it. */
  value: FormValueView;
}

/**
 * The value of one sensitive answer of a document, for a sender who asked to see it. Only a field the form marks sensitive
 * and that the signer is shown (a hidden answer is not shown to the sender either); 404 otherwise, so the route says nothing
 * about answers it will not reveal. The event is written first and is required: no record, no value.
 */
export async function revealAnswer(ctx: SignCtx, documentId: string, fieldKey: unknown): Promise<RevealResult> {
  const doc = await loadDocument(ctx, documentId);
  const form = formOf(doc);
  const field = typeof fieldKey === "string" ? form?.fields.find((f) => f.key === fieldKey) : undefined;
  if (!form || !field || field.sensitive !== true) throw new SignError("answer_not_found", "That answer was not found.", 404);
  const { state } = await loadFormState(ctx, doc, form);
  const value = state.map[field.key];
  if (!value || !fieldVisible(form, field, state.map)) throw new SignError("answer_not_found", "That answer was not found.", 404);
  await logEvent(ctx, documentId, "sensitive_viewed", { actor: "user", userId: ctx.userId, detail: { field: field.key }, strict: true });
  return { field: field.key, value: toView(value) };
}
