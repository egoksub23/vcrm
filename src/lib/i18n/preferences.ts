import { createClient } from '@/lib/supabase/server';

export interface LocalePreferences {
  /** The signed-in person's own language, if they chose one. */
  user: string | null;
  /** Their workspace's language, if it chose one. */
  account: string | null;
}

const NONE: LocalePreferences = { user: null, account: null };

/**
 * The language choices of whoever is making this request (migration 144).
 * Never throws and never blocks rendering for long: signed out, a read error or
 * a database that predates the columns all mean "no preference". Row security
 * scopes both reads: a person sees only their own profile and their own
 * workspace (one login belongs to one workspace).
 */
export async function loadLocalePreferences(): Promise<LocalePreferences> {
  try {
    const supabase = await createClient();
    // Verifies the token locally; no round trip to the auth server.
    const { data: claims } = await supabase.auth.getClaims();
    const userId = claims?.claims?.sub;
    if (!userId) return NONE;

    const [profile, account] = await Promise.all([
      supabase.from('profiles').select('locale').eq('user_id', userId).maybeSingle(),
      supabase.from('accounts').select('locale').limit(1).maybeSingle(),
    ]);
    return {
      user: profile.error ? null : ((profile.data as { locale?: string | null } | null)?.locale ?? null),
      account: account.error ? null : ((account.data as { locale?: string | null } | null)?.locale ?? null),
    };
  } catch {
    return NONE;
  }
}
