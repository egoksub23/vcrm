// ============================================================
// Registration pages and the contact: find or make the one contact for a person who submitted a form.
//
// What a stranger types is not verified (only the document that goes to the email proves that address, later),
// so the rules are the widget's cautious ones (lib/widget/identity-resolve.ts), tightened for a page that also
// starts a document:
//
//   * MATCH BY EMAIL ONLY. The document is sent to the address typed, so whoever reads it controls that address:
//     linking it to the contact that owns the address exposes nothing to a stranger.
//   * Existing contact: only EMPTY fields are filled (name, company, phone); nothing is ever overwritten, so
//     typing someone's email cannot rewrite their record.
//   * A phone number that already belongs to another contact is never attached to this one: the person gets a
//     new contact without a number, and the pair is put to the agents as a possible duplicate (the same
//     "contact_merge_suggestions" the widget uses). Typing a stranger's number can therefore neither link their
//     contact to a document nor show their details to the typist.
//   * A new contact is a lead, within the workspace's contact limit.
//
// Every read and write is scoped to the workspace. Returns the contact's id and whether it was created.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { resolveAuditUserId } from "@/lib/api/v1/contacts";
import { findExistingContact, isUniqueViolation } from "@/lib/contacts/dedupe";
import { assertCanAddContact } from "@/lib/platform/usage";
import { escapeLikeExact } from "@/lib/widget/identity-resolve";

export interface ApplicantDetails {
  fullName: string | null;
  /** Lower case. */
  email: string;
  /** Digits only, or null. */
  phone: string | null;
  company: string | null;
}

export interface ApplicantContact {
  id: string;
  created: boolean;
}

interface ContactRow {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  company: string | null;
}

const PLACEHOLDER_NAME = "Website visitor";

/** A name that is only a stand-in (empty, the widget's placeholder, or the phone number the contact was made from). */
function isPlaceholderName(c: ContactRow): boolean {
  const n = (c.name ?? "").trim();
  return !n || n === PLACEHOLDER_NAME || n === (c.phone ?? "").trim();
}

async function fillEmptyFields(admin: SupabaseClient, accountId: string, existing: ContactRow, who: ApplicantDetails): Promise<void> {
  const patch: Record<string, unknown> = {};
  if (who.fullName && isPlaceholderName(existing)) patch.name = who.fullName;
  if (who.company && !(existing.company ?? "").trim()) patch.company = who.company;
  if (who.phone && !(existing.phone ?? "").trim()) {
    // a number can only be filled when nothing else in the workspace owns it (the unique phone index would refuse it)
    const owner = await findExistingContact(admin, accountId, who.phone, existing.id);
    if (!owner) patch.phone = who.phone;
  }
  if (Object.keys(patch).length === 0) return;
  const { error } = await admin.from("contacts").update(patch).eq("id", existing.id).eq("account_id", accountId);
  // a failed fill never stops the registration: the document still goes out
  if (error) console.error("[sign] could not fill the contact from a registration:", error.message);
}

/** Find the contact for this email, or make one. Throws UsageLimitError at the workspace's contact limit. */
export async function upsertApplicantContact(admin: SupabaseClient, accountId: string, who: ApplicantDetails): Promise<ApplicantContact> {
  const found = await admin
    .from("contacts")
    .select("id, name, phone, email, company")
    .eq("account_id", accountId)
    .is("deleted_at", null)
    .ilike("email", escapeLikeExact(who.email))
    .order("created_at", { ascending: true })
    .limit(1);
  if (found.error) throw new Error(`contact lookup failed: ${found.error.message}`);
  const existing = ((found.data ?? []) as ContactRow[])[0];
  if (existing) {
    await fillEmptyFields(admin, accountId, existing, who);
    return { id: existing.id, created: false };
  }

  await assertCanAddContact(admin, accountId);
  const owner = await resolveAuditUserId(admin, accountId);
  const phoneOwner = who.phone ? await findExistingContact(admin, accountId, who.phone) : null;
  const row = (phone: string) => ({
    account_id: accountId,
    user_id: owner,
    phone,
    name: who.fullName ?? who.company ?? who.email,
    email: who.email,
    company: who.company,
    lifecycle_stage: "lead",
  });

  let inserted = await admin.from("contacts").insert(row(phoneOwner ? "" : (who.phone ?? ""))).select("id").single();
  if (inserted.error && isUniqueViolation(inserted.error) && who.phone && !phoneOwner) {
    // another request took the number a moment ago: this person still gets their own contact, without it
    inserted = await admin.from("contacts").insert(row("")).select("id").single();
  }
  if (inserted.error || !inserted.data) throw new Error(`contact insert failed: ${inserted.error?.message ?? "no row"}`);
  const id = (inserted.data as { id: string }).id;

  if (phoneOwner) {
    const { error } = await admin.from("contact_merge_suggestions").insert({ account_id: accountId, contact_a_id: phoneOwner.id, contact_b_id: id, source: "sign_registration" });
    // the pair already exists (pending, or dismissed by an agent): leave it be
    if (error && !isUniqueViolation(error)) console.error("[sign] could not record a possible duplicate:", error.message);
  }
  return { id, created: true };
}
