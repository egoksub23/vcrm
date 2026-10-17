// ============================================================
// Forms and the contact. Two directions, both through the data field's `contactField`:
//
//   prefill     every time a signer's page is built, fields they have not made their own start with the contact's
//               value (source "contact": shown for the signer to confirm) or the field's own default (source
//               "sender"); a contact value the sender corrects later replaces an unconfirmed one. Never overwrites
//               what the signer typed, saved, confirmed or emptied (see `prefillAnswers`).
//   write-back  once the signer has signed, what they confirmed fills the contact (name, email, company or a
//               custom field of the workspace), respecting "only if empty", and each change is an audit event
//               with the old and the new value (personal data, and the trail the plan asks for).
//
// Neither may ever fail a signing: they log and carry on. Every read and write is scoped to the workspace.
// ============================================================

import { checkDataAnswer, displayValue, fieldVisible, type DataAnswerInput, type DataField, type FormDefinition, type FormValue } from "../forms";
import type { SignDocumentRow, SignSignerRow } from "../types";
import { logEvent, type SignCtx } from "./context";
import { ownDataFields, ownDataFieldsFor, type AnswerRow, type FormState } from "./form-state";
import { sealAnswer } from "./sensitive";

const COLUMNS = ["name", "email", "company"] as const;
type Column = (typeof COLUMNS)[number];

interface ContactRow {
  id: string;
  name: string | null;
  email: string | null;
  company: string | null;
}

async function loadContact(ctx: SignCtx, contactId: string): Promise<ContactRow | null> {
  const { data, error } = await ctx.admin.from("contacts").select("id, name, email, company").eq("id", contactId).eq("account_id", ctx.accountId).is("deleted_at", null).maybeSingle();
  if (error || !data) return null;
  return data as ContactRow;
}

/** The workspace's custom contact field with this name, or null (the field is never created from here). */
async function customFieldId(ctx: SignCtx, name: string): Promise<string | null> {
  const { data, error } = await ctx.admin.from("custom_fields").select("id").eq("account_id", ctx.accountId).eq("field_name", name).limit(1);
  const row = (data as { id: string }[] | null)?.[0];
  return error || !row ? null : row.id;
}

async function customValue(ctx: SignCtx, contactId: string, fieldId: string): Promise<string> {
  const { data } = await ctx.admin.from("contact_custom_values").select("value").eq("contact_id", contactId).eq("custom_field_id", fieldId).maybeSingle();
  const v = (data as { value?: unknown } | null)?.value;
  return typeof v === "string" ? v.trim() : "";
}

/** What the contact holds for a `contactField`, as text ("" when empty), or null when the field cannot be read. */
async function readContactField(ctx: SignCtx, contact: ContactRow, contactField: string): Promise<string | null> {
  if ((COLUMNS as readonly string[]).includes(contactField)) return (contact[contactField as Column] ?? "").trim();
  if (contactField.startsWith("custom:")) {
    const id = await customFieldId(ctx, contactField.slice("custom:".length));
    return id ? customValue(ctx, contact.id, id) : null;
  }
  return null;
}

/** A starting text turned into what a browser would have sent for this field, or null when the type takes no such value. */
function inputFor(field: DataField, raw: string): DataAnswerInput | null {
  switch (field.type) {
    case "file":
    case "image":
      return null;
    case "yesno": {
      const v = raw.trim().toLowerCase();
      return ["yes", "true", "1"].includes(v) ? { checked: true } : ["no", "false", "0"].includes(v) ? { checked: false } : null;
    }
    case "acknowledge":
      return null; // accepting is the signer's own act
    case "multichoice":
      return { choices: raw.split(",").map((s) => s.trim()).filter(Boolean) };
    case "list":
      return { list: raw.split("\n").map((s) => s.trim()).filter(Boolean) };
    default:
      return { text: raw };
  }
}

/** A value, checked as a signer's own entry would be; null when it is empty or not acceptable for the field. */
function acceptable(field: DataField, raw: string): FormValue | null {
  if (!raw.trim()) return null;
  const input = inputFor(field, raw);
  if (!input) return null;
  const r = checkDataAnswer(field, input);
  return r.ok ? r.value : null;
}

/** Can this field be started from the contact or a default? Such a field keeps a marker when the signer empties it (see `saveAnswers`). */
export const canBePrefilled = (f: Pick<DataField, "contactField" | "defaultValue" | "type">): boolean => !!(f.contactField || f.defaultValue) && f.type !== "file" && f.type !== "image" && f.type !== "acknowledge";

/**
 * Start a signer's fields from the contact and from the fields' defaults. Runs every time the page is built, and
 * touches only what the signer has not made their own:
 *
 *   - no row for the field: the value is added (a value the sender supplied after the first view shows up);
 *   - a row the prefill itself wrote (source "contact" or "sender", never confirmed): replaced when the
 *     contact now gives a different value (a correction shows up), and left alone when there is no value to give;
 *   - a row of source "signer" or "forwarded" (typed, saved, or confirmed), and the empty marker `saveAnswers` leaves
 *     when the signer emptied a prefilled field (value null, source "signer"): never touched.
 *
 * `rows` are the document's answers as loaded; `signers` are the people of the document (a part handed to a delegate
 * is not prefilled for the person who handed it over). Returns the rows it wrote (so the caller need not read them
 * again). Failures are logged and give nothing.
 */
export async function prefillAnswers(ctx: SignCtx, doc: SignDocumentRow, signer: SignSignerRow, form: FormDefinition, state: FormState, rows: readonly AnswerRow[] = [], signers: readonly SignSignerRow[] = []): Promise<AnswerRow[]> {
  try {
    const own = ownDataFieldsFor(form, signer, signers);
    const mine = new Map(rows.filter((r) => r.signer_id === signer.id).map((r) => [r.field_key, r]));
    const wanted = [...own.values()].filter((f) => {
      if (!canBePrefilled(f) || !fieldVisible(form, f, state.map)) return false;
      const there = mine.get(f.key);
      if (there) {
        // the signer's own answer, or their deliberate empty: never touched. Only what a prefill wrote and nobody has confirmed may be refreshed.
        if (there.value === null || there.value === undefined) return false;
        if (there.source !== "contact" && there.source !== "sender") return false;
        // a default is part of the frozen form and cannot have changed; only a field that reads the contact can have something new to say
        return !!f.contactField;
      }
      return !state.map[f.key]; // an answer of another person of the role counts as answered, as it always has
    });
    if (wanted.length === 0) return [];
    const contact = doc.contact_id && wanted.some((f) => f.contactField) ? await loadContact(ctx, doc.contact_id) : null;

    const at = ctx.now().toISOString();
    const written: AnswerRow[] = [];
    const fresh: AnswerRow[] = [];
    const refreshed: AnswerRow[] = [];
    for (const f of wanted) {
      let value: FormValue | null = null;
      let source: "contact" | "sender" = "contact";
      if (f.contactField && contact) {
        const raw = await readContactField(ctx, contact, f.contactField);
        if (raw) value = acceptable(f, raw);
      }
      if (!value && f.defaultValue) {
        value = acceptable(f, f.defaultValue);
        source = "sender";
      }
      if (!value) continue;
      const there = mine.get(f.key);
      const row: AnswerRow = { signer_id: signer.id, field_key: f.key, value, source, saved_at: at };
      if (!there) {
        fresh.push(row);
      } else if (JSON.stringify(there.value) !== JSON.stringify(value) || there.source !== source) {
        refreshed.push(row);
      }
    }
    if (fresh.length) {
      const { error } = await ctx.admin.from("sign_answers").upsert(
        fresh.map((r) => ({ account_id: ctx.accountId, document_id: doc.id, ...r, ...sealAnswer(own.get(r.field_key), r.value, { documentId: doc.id, fieldKey: r.field_key }) })),
        { onConflict: "document_id,signer_id,field_key", ignoreDuplicates: true },
      );
      if (error) console.error("[sign] could not prefill answers:", error.message);
      else written.push(...fresh);
    }
    for (const r of refreshed) {
      // the filter on the source is part of the write: an answer the signer saves in the meantime is not overwritten
      const { data, error } = await ctx.admin
        .from("sign_answers")
        .update({ ...sealAnswer(own.get(r.field_key), r.value, { documentId: doc.id, fieldKey: r.field_key }), source: r.source, saved_at: r.saved_at })
        .eq("document_id", doc.id)
        .eq("account_id", ctx.accountId)
        .eq("signer_id", signer.id)
        .eq("field_key", r.field_key)
        .in("source", ["contact", "sender"])
        .select("field_key");
      if (error) console.error("[sign] could not refresh a prefilled answer:", error.message);
      else if (((data as unknown[] | null) ?? []).length > 0) written.push(r);
    }
    return written;
  } catch (err) {
    console.error("[sign] prefill failed:", err instanceof Error ? err.message : err);
    return [];
  }
}

export interface WriteBackChange {
  field: string;
  old: string;
  new: string;
}

/**
 * After signing: the answers the signer confirmed fill the contact. A field marked "if_empty" only fills an
 * empty value; an unchanged value is not written. Each change is logged as one `writeback` event.
 */
export async function writeBackToContact(ctx: SignCtx, doc: SignDocumentRow, signer: SignSignerRow, form: FormDefinition, state: FormState): Promise<WriteBackChange[]> {
  const changes: WriteBackChange[] = [];
  try {
    if (!doc.contact_id) return changes;
    const own = ownDataFields(form, signer.role_key);
    // a sensitive answer never goes to the contact, whatever the form says (the builder refuses the pair; this is the last line)
    const mapped = [...own.values()].filter((f) => f.contactField && !f.sensitive && state.map[f.key] && state.source[f.key] === "signer" && fieldVisible(form, f, state.map));
    if (mapped.length === 0) return changes;
    const contact = await loadContact(ctx, doc.contact_id);
    if (!contact) return changes;

    const columns: Partial<Record<Column, string>> = {};
    for (const f of mapped) {
      const target = f.contactField as string;
      const next = displayValue(f, state.map[f.key], doc.locale, ", ").trim();
      if (!next) continue;
      const current = await readContactField(ctx, contact, target);
      if (current === null) continue; // a custom field that no longer exists
      if (current === next) continue;
      if (f.writeBack === "if_empty" && current !== "") continue;
      if ((COLUMNS as readonly string[]).includes(target)) {
        columns[target as Column] = next;
      } else {
        const id = await customFieldId(ctx, target.slice("custom:".length));
        if (!id) continue;
        const { error } = await ctx.admin.from("contact_custom_values").upsert({ contact_id: contact.id, custom_field_id: id, value: next }, { onConflict: "contact_id,custom_field_id" });
        if (error) {
          console.error("[sign] write-back to a custom field failed:", error.message);
          continue;
        }
      }
      changes.push({ field: target, old: current, new: next });
    }
    if (Object.keys(columns).length) {
      const { error } = await ctx.admin.from("contacts").update({ ...columns, updated_at: ctx.now().toISOString() }).eq("id", contact.id).eq("account_id", ctx.accountId);
      if (error) {
        console.error("[sign] write-back to the contact failed:", error.message);
        // nothing was written for the columns: do not claim it in the trail
        for (let i = changes.length - 1; i >= 0; i--) if ((COLUMNS as readonly string[]).includes(changes[i].field)) changes.splice(i, 1);
      }
    }
    for (const c of changes) await logEvent(ctx, doc.id, "writeback", { actor: "signer", signerId: signer.id, detail: { field: c.field, old: c.old, new: c.new } });
  } catch (err) {
    console.error("[sign] write-back failed:", err instanceof Error ? err.message : err);
  }
  return changes;
}
