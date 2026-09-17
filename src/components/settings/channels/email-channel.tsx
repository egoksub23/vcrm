'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, PlugZap, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { SettingsPanelHead } from '../settings-panel-head';
import type { EmailConnectionStatus } from '@/types';

const BASE = '/api/account/channels/email';

/**
 * Settings → Channels → Email. Its own component rather than reusing
 * `MetaChannelPanel` — a Microsoft 365 connection is always the signed-
 * in user's own single mailbox (no Page-picker step), so there's no
 * picker state to carry, and it's a Microsoft Graph connection, not a
 * Meta one (different OAuth routes, different status shape).
 */
export function EmailChannel() {
  const t = useTranslations('Settings.channels.email');
  const { user, accountId, loading: authLoading, profileLoading, canEditSettings } = useAuth();
  const searchParams = useSearchParams();

  const [status, setStatus] = useState<EmailConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(BASE);
      const data = await res.json();
      if (res.ok) setStatus(data);
    } catch (err) {
      console.error('[email-channel] fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchStatus();
  }, [authLoading, profileLoading, user, accountId, fetchStatus]);

  const handledParamsRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchParams.get('channel') !== 'email') return;
    const key = searchParams.toString();
    if (handledParamsRef.current === key) return;
    handledParamsRef.current = key;

    if (searchParams.get('connected') === '1') {
      toast.success(t('connected'));
      fetchStatus();
    } else if (searchParams.get('oauth_error')) {
      const code = searchParams.get('oauth_error') ?? 'unknown';
      const known = ['invalid_state', 'denied'].includes(code) ? code : 'unknown';
      toast.error(t(`oauthError.${known}`));
    }
  }, [searchParams, t, fetchStatus]);

  async function handleDisconnect() {
    if (!confirm(t('disconnectConfirmDescription'))) return;
    setDisconnecting(true);
    try {
      const res = await fetch(BASE, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error || t('disconnectFailed'));
        return;
      }
      setStatus({ connected: false, needs_reauth: false, status: 'disconnected' });
      toast.success(t('disconnected'));
    } catch (err) {
      console.error('[email-channel] disconnect error:', err);
      toast.error(t('disconnectFailed'));
    } finally {
      setDisconnecting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {status?.needs_reauth ? (
        <Card className="mb-6 border-amber-500/30 bg-amber-500/10">
          <CardContent className="flex items-center justify-between gap-4 py-4">
            <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
              <AlertTriangle className="size-4 shrink-0" />
              {t('reauthBanner')}
            </div>
            {canEditSettings ? (
              <a href={`${BASE}/oauth/start`} className={buttonVariants({ size: 'sm' })}>
                {t('reauthButton')}
              </a>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="py-5">
          {status?.connected ? (
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('connectedAs', { mailbox: status.mailbox_address ?? '' })}
                </p>
                {status.connected_at ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('connectedAtLabel')} {new Date(status.connected_at).toLocaleDateString()}
                  </p>
                ) : null}
              </div>
              {canEditSettings ? (
                <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={disconnecting}>
                  {disconnecting ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t('disconnect')}
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">{t('notConnected')}</p>
              {canEditSettings ? (
                <a href={`${BASE}/oauth/start`} className={buttonVariants({})}>
                  <PlugZap className="size-4" />
                  {t('connectButton')}
                </a>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
