'use client';

import { AlertTriangle, Lock, RefreshCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/** Skeleton shown while the matrix loads (role list + rows). */
export function RolesSkeleton() {
  const t = useTranslations('Permissions.screen');
  return (
    <div
      className="grid gap-4 lg:grid-cols-[16rem_1fr]"
      role="status"
      aria-live="polite"
      aria-label={t('loading')}
    >
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-16 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
      <div className="space-y-3">
        <div className="h-28 animate-pulse rounded-xl bg-muted" />
        <div className="h-10 animate-pulse rounded-xl bg-muted" />
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg bg-muted/70" />
        ))}
      </div>
      <span className="sr-only">{t('loading')}</span>
    </div>
  );
}

/** The person lacks roles.manage (a deep link can still reach the tab). */
export function NoAccessState() {
  const t = useTranslations('Permissions.screen');
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-2 py-12 text-center">
        <Lock className="size-6 text-muted-foreground" />
        <p className="text-sm font-medium text-foreground">
          {t('noAccessTitle')}
        </p>
        <p className="max-w-md text-sm text-muted-foreground">
          {t('noAccessBody')}
        </p>
      </CardContent>
    </Card>
  );
}

/** Load failed: show the server message (if any) and a retry button. */
export function LoadErrorState({
  message,
  onRetry,
}: {
  message: string | null;
  onRetry: () => void;
}) {
  const t = useTranslations('Permissions.screen');
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <AlertTriangle className="size-6 text-amber-500" />
        <p className="text-sm font-medium text-foreground">{t('loadFailed')}</p>
        <p className="max-w-md text-sm text-muted-foreground">
          {message ?? t('loadFailedBody')}
        </p>
        <Button variant="outline" onClick={onRetry}>
          <RefreshCw className="size-4" />
          {t('retry')}
        </Button>
      </CardContent>
    </Card>
  );
}
