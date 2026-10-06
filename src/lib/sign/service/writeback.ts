// ============================================================
// Forms and the contact. Two directions, both through the data field's `contactField`:
//
//   prefill     the first time a signer opens their page, fields they have not answered start with the contact's
//               value (source "contact": shown for the signer to confirm) or the field's own default (source
//               "sender"). Never overwrites an answer.
//   write-back  once the signer has signed, what they confirmed fills the contact (name, email, company or a
//               custom field of the workspace), respecting "only if empty", and each change is an audit event
//               with the old and the new value (personal data, and the trail the plan asks for).
//
// Neither may ever fail a signing: they log and carry on. Every read and write is scoped to the workspace.
// ============================================================

import { checkDataAnswer, displayValue, fieldVisible, type DataAnswerInput, type DataField, type FormDefinition, type FormValue } from "../forms";
import type { SignDocumentRow, SignSignerRow } from "../types";
import { logEvent, type SignCtx } from "./context";
import { ownDataFields, type AnswerRow, type FormState } from "./form-state";

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

/**
 * Start a signer's unanswered, visible fields from the contact and from the fields' defaults. Returns the rows
 * it wrote (so the caller need not read them again). Failures are logged and give nothing.
 */
export async function prefillAnswers(ctx: SignCtx, doc: SignDocumentRow, signer: SignSignerRow, form: FormDefinition, state: FormState): Promise<AnswerRow[]> {
  try {
    const own = ownDataFields(form, signer.role_key);
    const wanted = [...own.values()].filter((f) => !state.map[f.key] && (f.contactField || f.defaultValue) && fieldVisible(form, f, state.map));
    if (wanted.length === 0) return [];
    const contact = doc.contact_id && wanted.some((f) => f.contactField) ? await loadContact(ctx, doc.contact_id) : null;

    const at = ctx.now().toISOString();
    const rows: AnswerRow[] = [];
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
      if (value) rows.push({ signer_id: signer.id, field_key: f.key, value, source, saved_at: at });
    }
    if (rows.length === 0) return [];
    const { error } = await ctx.admin.from("sign_answers").upsert(
      rows.map((r) => ({ account_id: ctx.accountId, document_id: doc.id, ...r })),
      { onConflict: "document_id,signer_id,field_key", ignoreDuplicates: true },
    );
    if (error) {
      console.error("[sign] could not prefill answers:", error.message);
      return [];
    }
    return rows;
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
    const mapped = [...own.values()].filter((f) => f.contactField && state.map[f.key] && state.source[f.key] === "signer" && fieldVisible(form, f, state.map));
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
