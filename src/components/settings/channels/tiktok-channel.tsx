'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, Copy, Loader2, PlugZap } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth, useCapability } from '@/hooks/use-auth';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SettingsPanelHead } from '../settings-panel-head';

interface TikTokStatus {
  app_configured: boolean;
  connected: boolean;
  display_name: string | null;
  username: string | null;
  connected_at: string | null;
  needs_reauth: boolean;
  webhook_registered_at: string | null;
  last_synced_at: string | null;
  redirect_uri: string;
  webhook_url: string;
}

function CopyField({ label, value, copiedMsg }: { label: string; value: string; copiedMsg: string }) {
  return (
    <div className="space-y-2">
      <Label className="text-muted-foreground">{label}</Label>
      <div className="flex gap-2">
        <Input readOnly value={value} className="bg-muted border-border text-muted-foreground font-mono text-sm" />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="shrink-0"
          onClick={() => {
            void navigator.clipboard.writeText(value);
            toast.success(copiedMsg);
          }}
        >
          <Copy className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Settings → Channels → TikTok. Connects a TikTok business account so its
 * video comments arrive in the Comments inbox and can be answered from the
 * CRM. Sign-in is TikTok's own authorization page; tokens are stored
 * encrypted and refreshed automatically.
 */
export function TikTokChannel() {
  const t = useTranslations('Settings.channels.tiktok');
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();
  const canManageChannels = useCapability('channels.manage');
  const searchParams = useSearchParams();

  const [status, setStatus] = useState<TikTokStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<'disconnect' | 'webhook' | 'sync' | null>(null);
  const loadedRef = useRef<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/account/channels/tiktok', { cache: 'no-store' });
      const data = await res.json();
      if (res.ok) setStatus(data);
    } catch (err) {
      console.error('[tiktok-channel] fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLoading(false);
      return;
    }
    if (loadedRef.current === accountId) return;
    loadedRef.current = accountId;
    void fetchStatus();
  }, [authLoading, profileLoading, user, accountId, fetchStatus]);

  // The connect flow redirects back with ?connected=1 or ?oauth_error=.
  const handledRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchParams.get('channel') !== 'tiktok') return;
    const key = searchParams.toString();
    if (handledRef.current === key) return;
    handledRef.current = key;
    if (searchParams.get('connected') === '1') {
      toast.success(t('connected'));
      void fetchStatus();
    } else if (searchParams.get('oauth_error')) {
      const code = searchParams.get('oauth_error') ?? 'unknown';
      const known = ['invalid_state', 'denied', 'not_configured', 'already_connected', 'exchange_failed', 'save_failed'].includes(code)
        ? code
        : 'unknown';
      toast.error(t(`oauthError.${known}`));
    }
  }, [searchParams, t, fetchStatus]);

  async function disconnect() {
    if (!confirm(t('disconnectConfirm'))) return;
    setBusy('disconnect');
    try {
      const res = await fetch('/api/account/channels/tiktok', { method: 'DELETE' });
      if (!res.ok) {
        toast.error(t('disconnectFailed'));
        return;
      }
      toast.success(t('disconnected'));
      void fetchStatus();
    } finally {
      setBusy(null);
    }
  }

  async function registerWebhook() {
    setBusy('webhook');
    try {
      const res = await fetch('/api/account/channels/tiktok/webhook', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('webhookFailed'));
        return;
      }
      toast.success(t('webhookRegistered'));
      void fetchStatus();
    } finally {
      setBusy(null);
    }
  }

  async function syncNow() {
    setBusy('sync');
    try {
      const res = await fetch('/api/comments/sync', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? t('syncFailed'));
        return;
      }
      toast.success(t('synced', { count: data.newComments ?? 0 }));
      void fetchStatus();
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  const connectHref = '/api/account/channels/tiktok/oauth/start';

  return (
    <div>
      <SettingsPanelHead title={t('title')} description={t('description')} />

      {status && !status.app_configured ? (
        <Card className="mb-6 border-amber-500/30 bg-amber-500/10">
          <CardContent className="flex items-start gap-2 py-4 text-sm text-amber-700 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <span>{t('notConfigured')}</span>
          </CardContent>
        </Card>
      ) : null}

      {status?.needs_reauth ? (
        <Card className="mb-6 border-amber-500/30 bg-amber-500/10">
          <CardContent className="flex items-center justify-between gap-4 py-4">
            <div className="flex items-center gap-2 text-sm text-amber-700 dark:text-amber-400">
              <AlertTriangle className="size-4 shrink-0" />
              {t('reauthBanner')}
            </div>
            {canManageChannels ? (
              <a href={connectHref} className={buttonVariants({ size: 'sm' })}>
                {t('reauthButton')}
              </a>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="py-5">
          {status?.connected ? (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('connectedAs', { name: status.display_name || status.username || 'TikTok' })}
                </p>
                {status.username ? <p className="text-xs text-muted-foreground">@{status.username}</p> : null}
                {status.connected_at ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('connectedAtLabel')} {new Date(status.connected_at).toLocaleDateString()}
                    {status.last_synced_at ? ` · ${t('lastSynced')} ${new Date(status.last_synced_at).toLocaleString()}` : ''}
                  </p>
                ) : null}
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void syncNow()} disabled={busy !== null}>
                  {busy === 'sync' ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t('syncNow')}
                </Button>
                {canManageChannels ? (
                  <Button size="sm" variant="outline" onClick={() => void disconnect()} disabled={busy !== null}>
                    {busy === 'disconnect' ? <Loader2 className="size-4 animate-spin" /> : null}
                    {t('disconnect')}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">{t('notConnected')}</p>
              {canManageChannels && status?.app_configured ? (
                <a href={connectHref} className={buttonVariants({})}>
                  <PlugZap className="size-4" />
                  {t('connectButton')}
                </a>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      {canManageChannels && status ? (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="text-base">{t('setupTitle')}</CardTitle>
            <CardDescription>{t('setupDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <CopyField label={t('redirectLabel')} value={status.redirect_uri} copiedMsg={t('copied')} />
            <CopyField label={t('webhookUrlLabel')} value={status.webhook_url} copiedMsg={t('copied')} />
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => void registerWebhook()}
                disabled={busy !== null || !status.app_configured}
              >
                {busy === 'webhook' ? <Loader2 className="size-4 animate-spin" /> : null}
                {status.webhook_registered_at ? t('webhookReRegister') : t('webhookRegister')}
              </Button>
              {status.webhook_registered_at ? (
                <span className="text-xs text-emerald-600 dark:text-emerald-400">
                  {t('webhookRegisteredOn', { date: new Date(status.webhook_registered_at).toLocaleDateString() })}
                </span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">{t('webhookHint')}</p>
          </CardContent>
        </Card>
      ) : null}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">{t('limitsTitle')}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            <li>{t('limitPrivate')}</li>
            <li>{t('limitDelete')}</li>
            <li>{t('limitAds')}</li>
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
