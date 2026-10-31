// Server-side data client — Phase D postgres.js migration.
//
// When DATABASE_URL is set, returns a PgDb instance (postgres.js backed)
// cast as SupabaseClient so all 14 server-side call sites need no changes.
// RLS is enforced by SET LOCAL role + jwt.claims in each query transaction.
//
// When DATABASE_URL is not set, falls back to the Supabase PostgREST client
// using the Auth.js session JWT (backward-compat for environments without
// a direct DB connection configured yet).

import { auth } from "@/auth";
import type { SupabaseClient } from "@supabase/supabase-js";

export async function createClient(): Promise<SupabaseClient> {
  const session = await auth();

  if (process.env.DATABASE_URL) {
    const { createPgDb } = await import("@/lib/postgres/db");
    const userId = (session?.user as { id?: string } | undefined)?.id ?? null;
    return createPgDb(userId) as unknown as SupabaseClient;
  }

  // Legacy Supabase PostgREST path (used when DATABASE_URL is not yet configured)
  const { createClient: createSupabaseClient } = await import("@supabase/supabase-js");
  const token = session?.supabaseAccessToken;
  return createSupabaseClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      global: {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    },
  );
}
