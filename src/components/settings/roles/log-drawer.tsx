'use client';

import { ArrowRight, Loader2 } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';

import type { RoleLogEntry } from '@/app/api/account/roles/log/route';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { capabilityI18nId, getCapability } from '@/lib/auth/capabilities';
import { isAccountRole, type AccountRole } from '@/lib/auth/roles';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 30;

interface LogDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The role selected on the screen; the drawer opens filtered to it. */
  role: AccountRole;
}

type Scope = 'role' | 'all';

export function LogDrawer({ open, onOpenChange, role }: LogDrawerProps) {
  const t = useTranslations('Permissions');
  const tRoles = useTranslations('Settings.roles');
  const [scope, setScope] = useState<Scope>('role');

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full data-[side=right]:sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t('log.title')}</SheetTitle>
          <SheetDescription>{t('log.description')}</SheetDescription>
        </SheetHeader>
        <div className="flex gap-2 px-4" role="group" aria-label={t('log.filter')}>
          <Button
            size="sm"
            variant={scope === 'role' ? 'default' : 'outline'}
            aria-pressed={scope === 'role'}
            onClick={() => setScope('role')}
          >
            {t('log.thisRole', { role: tRoles(role) })}
          </Button>
          <Button
            size="sm"
            variant={scope === 'all' ? 'default' : 'outline'}
            aria-pressed={scope === 'all'}
            onClick={() => setScope('all')}
          >
            {t('log.allRoles')}
          </Button>
        </div>
        {/* Remounting on filter change resets the list to its loading state. */}
        <LogList key={`${scope}:${role}`} role={scope === 'role' ? role : null} />
      </SheetContent>
    </Sheet>
  );
}

function LogList({ role }: { role: AccountRole | null }) {
  const t = useTranslations('Permissions');
  const [entries, setEntries] = useState<RoleLogEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const fetchPage = useCallback(
    async (before: number | null) => {
      const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
      if (role) params.set('role', role);
      if (before !== null) params.set('before', String(before));
      const res = await fetch(`/api/account/roles/log?${params.toString()}`, {
        cache: 'no-store',
      });
      const payload = (await res.json().catch(() => ({}))) as {
        entries?: RoleLogEntry[];
        nextCursor?: number | null;
        error?: string;
      };
      if (!res.ok || !payload.entries) {
        throw new Error(payload.error ?? '');
      }
      return { entries: payload.entries, next: payload.nextCursor ?? null };
    },
    [role],
  );

  useEffect(() => {
    let cancelled = false;
    fetchPage(null)
      .then((page) => {
        if (cancelled) return;
        setEntries(page.entries);
        setCursor(page.next);
        setStatus('ready');
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setMessage(err.message || null);
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [fetchPage]);

  async function loadMore() {
    if (cursor === null) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(cursor);
      setEntries((prev) => [...prev, ...page.entries]);
      setCursor(page.next);
    } catch (err) {
      setMessage(err instanceof Error && err.message ? err.message : null);
      setStatus('error');
    } finally {
      setLoadingMore(false);
    }
  }

  if (status === 'loading') {
    return (
      <div className="flex items-center justify-center py-10" role="status">
        <Loader2 className="size-5 animate-spin text-primary" />
        <span className="sr-only">{t('log.loading')}</span>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="px-4 text-sm text-destructive" role="alert">
        {message ?? t('errors.logFailed')}
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-muted-foreground">
        {t('log.empty')}
      </p>
    );
  }

  return (
    <div className="flex-1 space-y-3 overflow-y-auto px-4 pb-4">
      <ul className="divide-y divide-border rounded-lg border border-border">
        {entries.map((entry) => (
          <LogRow key={entry.id} entry={entry} showRole={role === null} />
        ))}
      </ul>
      {cursor !== null ? (
        <Button
          variant="outline"
          className="w-full"
          onClick={loadMore}
          disabled={loadingMore}
        >
          {loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}
          {t('log.loadMore')}
        </Button>
      ) : null}
    </div>
  );
}

function LogRow({
  entry,
  showRole,
}: {
  entry: RoleLogEntry;
  showRole: boolean;
}) {
  const t = useTranslations('Permissions');
  const tRoles = useTranslations('Settings.roles');
  const format = useFormatter();
  const known = getCapability(entry.capability) !== undefined;
  const label = known
    ? t(`cap.${capabilityI18nId(entry.capability)}.label`)
    : entry.capability;
  const when = format.dateTime(new Date(entry.at), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const who = entry.actor?.name || t('log.unknownActor');

  return (
    <li className="space-y-1 px-3 py-2.5 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">{label}</span>
        <span className="inline-flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">
            {entry.oldGranted ? t('dialog.on') : t('dialog.off')}
          </span>
          <ArrowRight
            className="size-3 text-muted-foreground"
            aria-label={t('dialog.to')}
          />
          <span
            className={cn(
              'font-medium',
              entry.newGranted
                ? 'text-emerald-600 dark:text-emerald-300'
                : 'text-red-600 dark:text-red-300',
            )}
          >
            {entry.newGranted ? t('dialog.on') : t('dialog.off')}
          </span>
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {showRole && isAccountRole(entry.role)
          ? t('log.byWhoRole', { name: who, role: tRoles(entry.role), date: when })
          : t('log.byWho', { name: who, date: when })}
      </p>
    </li>
  );
}
