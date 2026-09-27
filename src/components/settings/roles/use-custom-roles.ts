'use client';

import { useCallback, useEffect, useState } from 'react';

import type { CustomRoleEntry, CustomRoleListResponse } from '@/app/api/account/roles/custom/route';

export type CustomRolesState =
  | { status: 'loading' }
  | { status: 'forbidden' }
  | { status: 'error'; message: string | null }
  | { status: 'ready'; data: CustomRoleEntry[] };

/** Loads GET /api/account/roles/custom, same shape/behavior as useRoleMatrix. */
export function useCustomRoles() {
  const [state, setState] = useState<CustomRolesState>({ status: 'loading' });

  const load = useCallback(async (): Promise<CustomRolesState> => {
    try {
      const res = await fetch('/api/account/roles/custom', { cache: 'no-store' });
      if (res.status === 403) return { status: 'forbidden' };
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        return { status: 'error', message: payload.error ?? null };
      }
      const body = (await res.json()) as CustomRoleListResponse;
      return { status: 'ready', data: body.roles };
    } catch (err) {
      console.error('[useCustomRoles] load error:', err);
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
