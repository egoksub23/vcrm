'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, MessageCircleMore } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Facebook / Instagram comments, from the channel's own settings panel.
 * Reading and moderating comments needs extra Meta permissions, so it is
 * opt-in: "Allow comments" reconnects with those permissions, and "Turn
 * on comments" then subscribes the Page to comment events.
 */
export function CommentsChannelCard({
  channel,
  enabledAt,
  canEdit,
  onEnabled,
}: {
  channel: 'messenger' | 'instagram';
  enabledAt: string | null | undefined;
  canEdit: boolean;
  onEnabled: () => void;
}) {
  const t = useTranslations('Settings.channels.comments');
  const [busy, setBusy] = useState(false);
  const source = channel === 'messenger' ? t('sourceFacebook') : t('sourceInstagram');

  async function turnOn() {
    setBusy(true);
    try {
      const res = await fetch(`/api/account/channels/${channel}/comments`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.reconnect ? t('needsPermission') : (data.error ?? t('enableFailed')));
        return;
      }
      toast.success(t('enabled'));
      onEnabled();
    } catch {
      toast.error(t('enableFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MessageCircleMore className="size-4 text-primary" /> {t('title', { source })}
        </CardTitle>
        <CardDescription>{t('description', { source })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {enabledAt ? (
          <p className="text-sm text-emerald-600 dark:text-emerald-400">
            {t('statusOn', { date: new Date(enabledAt).toLocaleDateString() })}
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">{t('statusOff')}</p>
        )}
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <a href={`/api/account/channels/${channel}/oauth/start?comments=1`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              {t('allowButton')}
            </a>
            <Button size="sm" onClick={() => void turnOn()} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {enabledAt ? t('refreshButton') : t('turnOnButton')}
            </Button>
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">{t('webhookHint', { source })}</p>
      </CardContent>
    </Card>
  );
}
