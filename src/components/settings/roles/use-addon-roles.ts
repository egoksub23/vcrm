'use client';

import { useCallback, useEffect, useState } from 'react';

import type { AddonRoleEntry, AddonRoleListResponse } from '@/lib/auth/addon-roles';

export type AddonRolesState =
  | { status: 'loading' }
  | { status: 'error'; message: string | null }
  | { status: 'ready'; data: AddonRoleEntry[] };

/** Loads GET /api/account/roles/addons (migration 191): the workspace's add-on roles, with the permission keys when the caller manages roles. */
export function useAddonRoles() {
  const [state, setState] = useState<AddonRolesState>({ status: 'loading' });

  const load = useCallback(async (): Promise<AddonRolesState> => {
    try {
      const res = await fetch('/api/account/roles/addons', { cache: 'no-store' });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        return { status: 'error', message: payload.error ?? null };
      }
      const body = (await res.json()) as AddonRoleListResponse;
      return { status: 'ready', data: body.addons };
    } catch (err) {
      console.error('[useAddonRoles] load error:', err);
      return { status: 'error', message: null };
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const refetch = useCallback(async (): Promise<boolean> => {
    const next = await load();
    if (next.status === 'ready') {
      setState(next);
      return true;
    }
    return false;
  }, [load]);

  return { state, refetch };
}
