'use client';

import { useCallback, useEffect, useState } from 'react';

import type { RoleMatrixResponse } from '@/app/api/account/roles/route';

export type MatrixState =
  | { status: 'loading' }
  | { status: 'forbidden' }
  | { status: 'error'; message: string | null }
  | { status: 'ready'; data: RoleMatrixResponse };

/**
 * Loads GET /api/account/roles. `refetch` refreshes in place (keeps the
 * screen on the current data while it runs) and resolves to true on
 * success. `retry` returns to the skeleton first.
 */
export function useRoleMatrix() {
  const [state, setState] = useState<MatrixState>({ status: 'loading' });

  const load = useCallback(async (): Promise<MatrixState> => {
    try {
      const res = await fetch('/api/account/roles', { cache: 'no-store' });
      if (res.status === 403) return { status: 'forbidden' };
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        return { status: 'error', message: payload.error ?? null };
      }
      return { status: 'ready', data: (await res.json()) as RoleMatrixResponse };
    } catch (err) {
      console.error('[RolesPermissionsTab] load error:', err);
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

  const retry = useCallback(async () => {
    setState({ status: 'loading' });
    setState(await load());
  }, [load]);

  return { state, refetch, retry };
}
