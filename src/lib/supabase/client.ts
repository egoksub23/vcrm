// Browser Supabase client — Phase 1 Auth.js migration.
//
// Reads the Supabase-compatible JWT from the sb-access-token cookie set by
// middleware on every server-rendered response. Injects it as the
// Authorization header so PostgREST sees auth.uid() and all RLS policies
// continue to work without any changes to existing query code.
//
// No singleton: token value drives identity. Creating a new
// @supabase/supabase-js instance is pure JS object allocation — there is
// no auth-lock contention risk because session persistence and token
// refresh are disabled (Auth.js owns those concerns now).

import { createClient as createSupabaseClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

function readTokenCookie(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|;\s*)sb-access-token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

export function createClient(): SupabaseClient {
  const token = readTokenCookie();
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
