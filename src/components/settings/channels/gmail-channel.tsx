'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, PlugZap, Loader2, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth, useCapability } from '@/hooks/use-auth';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { SettingsPanelHead } from '../settings-panel-head';
import { ChannelEnabledSwitch } from './channel-enabled-switch';
import type { GmailConnectionStatus } from '@/types';

const BASE = '/api/account/channels/gmail';

/**
 * Settings → Channels → Gmail. Its own component rather than reusing
 * `EmailChannel` — same OAuth-connect shape (single mailbox, no
 * picker), but Gmail additionally needs a "Pub/Sub setup" card: unlike
 * Microsoft 365's fully self-registering subscription, Gmail's push
 * endpoint (Google Cloud Pub/Sub) is one-time manual GCP setup this
 * app can't do on the operator's behalf (see docs/gmail-setup.md) —
 * this card shows exactly what to paste into that setup.
 */
export function GmailChannel() {
  const t = useTranslations('Settings.channels.gmail');
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();
  const canManageChannels = useCapability('channels.manage');
  const searchParams = useSearchParams();

  const [status, setStatus] = useState<GmailConnectionStatus | null>(null);
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
      console.error('[gmail-channel] fetch error:', err);
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
    if (searchParams.get('channel') !== 'gmail') return;
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
      setStatus({ connected: false, needs_reauth: false, status: 'disconnected', pubsub_configured: false, push_endpoint_url: null });
      toast.success(t('disconnected'));
    } catch (err) {
      console.error('[gmail-channel] disconnect error:', err);
      toast.error(t('disconnectFailed'));
    } finally {
      setDisconnecting(false);
    }
  }

  function handleCopyPushEndpoint() {
    if (!status?.push_endpoint_url) return;
    navigator.clipboard.writeText(status.push_endpoint_url);
    toast.success(t('pushEndpointCopied'));
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
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          status?.connected ? (
            <ChannelEnabledSwitch
              enabled={status.enabled ?? true}
              onChange={(next) => setStatus((prev) => (prev ? { ...prev, enabled: next } : prev))}
              patchUrl={BASE}
              disabled={!canManageChannels}
              idPrefix="gmail"
            />
          ) : undefined
        }
      />

      {status?.needs_reauth ? (
        <Card className="mb-6 border-amber-500/30 bg-amber-500/10">
          <CardContent className="flex items-center justify-between gap-4 py-4">
            <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
              <AlertTriangle className="size-4 shrink-0" />
              {t('reauthBanner')}
            </div>
            {canManageChannels ? (
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
                  {t('connectedAs', { mailbox: status.email_address ?? '' })}
                </p>
                {status.connected_at ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('connectedAtLabel')} {new Date(status.connected_at).toLocaleDateString()}
                  </p>
                ) : null}
              </div>
              {canManageChannels ? (
                <Button variant="outline" size="sm" onClick={handleDisconnect} disabled={disconnecting}>
                  {disconnecting ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t('disconnect')}
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">{t('notConnected')}</p>
              {canManageChannels ? (
                <a href={`${BASE}/oauth/start`} className={buttonVariants({})}>
                  <PlugZap className="size-4" />
                  {t('connectButton')}
                </a>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      {status?.connected ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">{t('pubsubTitle')}</CardTitle>
            <CardDescription>
              {status.pubsub_configured ? t('pubsubDescriptionConfigured') : t('pubsubDescriptionNotConfigured')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {!status.pubsub_configured ? (
              <p className="flex items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                <AlertTriangle className="size-3.5 shrink-0" />
                {t('pubsubNotConfiguredHint')}
              </p>
            ) : null}
            <Label className="text-muted-foreground">{t('pushEndpointLabel')}</Label>
            <div className="flex gap-2">
              <Input
                readOnly
                value={status.push_endpoint_url ?? ''}
                className="bg-muted border-border text-muted-foreground font-mono text-sm"
              />
              <Button type="button" variant="outline" size="icon" onClick={handleCopyPushEndpoint} className="shrink-0">
                <Copy className="size-4" />
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('pushEndpointHint')}</p>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
