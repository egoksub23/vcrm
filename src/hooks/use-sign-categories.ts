"use client";

import { useEffect, useState } from "react";

import { useAuth } from "@/hooks/use-auth";
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

export function useSignCategories(): { categories: SignCategory[]; live: SignCategory[]; loading: boolean } {
  const { accountId } = useAuth();
  const [loaded, setLoaded] = useState<Loaded<SignCategory[]> | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    fetch("/api/sign/categories")
      .then((r) => r.json())
      .then(({ categories }: { categories?: SignCategory[] }) => {
        if (cancelled) return;
        setLoaded({ accountId, value: categories ?? [] });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[useSignCategories] fetch error:", err);
        setLoaded({ accountId, value: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const categories = loaded && loaded.accountId === accountId ? loaded.value : [];
  return { categories, live: categories.filter((c) => !c.archived), loading: !loaded || loaded.accountId !== accountId };
}

export function useSignSettings(): { settings: SignSettingsRow | null; loading: boolean } {
  const { accountId } = useAuth();
  const [loaded, setLoaded] = useState<Loaded<SignSettingsRow | null> | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    fetch("/api/sign/settings/basic")
      .then((r) => r.json())
      .then(({ settings }: { settings?: SignSettingsRow | null }) => {
        if (cancelled) return;
        setLoaded({ accountId, value: settings ?? null });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("[useSignSettings] fetch error:", err);
        setLoaded({ accountId, value: null });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const ready = !!loaded && loaded.accountId === accountId;
  return { settings: ready ? loaded.value : null, loading: !ready };
}
