// ============================================================
// GET /api/contacts/deleted  (contacts.edit)
//
// Soft-deleted contacts, newest first. Row-level security hides them
// from the normal `contacts` read, so this goes through the
// SECURITY DEFINER function `list_deleted_contacts()` (migration 125),
// which checks contacts.edit itself and scopes to the caller's account.
// Backs the "Show deleted" toggle on the Contacts page.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";

interface DeletedContactRow {
  id: string;
  name: string | null;
  phone: string;
  email: string | null;
  company: string | null;
  created_at: string;
  deleted_at: string;
  deleted_by: string | null;
  deleted_by_name: string | null;
}

export async function GET() {
  try {
    const ctx = await requireCapability("contacts.edit");

    const { data, error } = await ctx.supabase.rpc("list_deleted_contacts", { p_limit: 200 });
    if (error) {
      console.error("[GET /api/contacts/deleted] rpc error:", error);
      return NextResponse.json({ error: "Failed to load deleted contacts" }, { status: 500 });
    }

    return NextResponse.json(
      { contacts: (data ?? []) as DeletedContactRow[] },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
