"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import type { SignSettingsRow } from "@/lib/sign/types";

export interface SignCategory {
  id: string;
  key: string;
  name: string;
  archived: boolean;
  expiry_days: number | null;
  reminder_days: number[] | null;
  code_required: boolean;
  sign_in_order: boolean;
  position: number;
}

interface Loaded<T> {
  accountId: string;
  value: T;
}

/**
 * The workspace's document categories (archived ones included, so an old document can still name its
 * category; the pickers list only the live ones). Read through row level security (menu.sign).
 */
export function useSignCategories(): { categories: SignCategory[]; live: SignCategory[]; loading: boolean } {
  const { accountId } = useAuth();
  const [loaded, setLoaded] = useState<Loaded<SignCategory[]> | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await createClient()
        .from("sign_categories")
        .select("id, key, name, archived, expiry_days, reminder_days, code_required, sign_in_order, position")
        .order("position", { ascending: true })
        .order("name", { ascending: true });
      if (cancelled) return;
      if (error) console.error("[useSignCategories] fetch error:", error);
      setLoaded({ accountId, value: error ? [] : ((data as SignCategory[]) ?? []) });
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const categories = loaded && loaded.accountId === accountId ? loaded.value : [];
  return { categories, live: categories.filter((c) => !c.archived), loading: !loaded || loaded.accountId !== accountId };
}

/** The workspace's Doc Sign settings row (defaults for expiry, reminders, language), or null when there is none yet. */
export function useSignSettings(): { settings: SignSettingsRow | null; loading: boolean } {
  const { accountId } = useAuth();
  const [loaded, setLoaded] = useState<Loaded<SignSettingsRow | null> | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await createClient().from("sign_settings").select("*").maybeSingle();
      if (cancelled) return;
      if (error) console.error("[useSignSettings] fetch error:", error);
      setLoaded({ accountId, value: error ? null : ((data as SignSettingsRow | null) ?? null) });
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const ready = !!loaded && loaded.accountId === accountId;
  return { settings: ready ? loaded.value : null, loading: !ready };
}
