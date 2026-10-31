// Server-side Supabase client — Phase 1 Auth.js migration.
//
// Replaces @supabase/ssr's createServerClient. Auth session management is
// now handled by Auth.js; we only need a client for data queries.
// The Auth.js session carries a Supabase-compatible JWT (signed with
// SUPABASE_JWT_SECRET, role:"authenticated", sub:<uuid>) so PostgREST
// sees auth.uid() and every RLS policy continues to work unchanged.

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import { auth } from "@/auth";

export async function createClient() {
  const session = await auth();
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
