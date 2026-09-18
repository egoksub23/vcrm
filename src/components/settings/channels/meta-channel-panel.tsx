'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { AlertTriangle, PlugZap, Loader2, Copy } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { SettingsPanelHead } from '../settings-panel-head';
import type { MetaChannelConnectionStatus } from '@/types';

interface MetaPage {
  id: string;
  name: string;
}

interface MetaChannelPanelProps {
  /** Drives every `/api/account/channels/<channel>/...` route below. */
  channel: 'messenger' | 'instagram';
  /** i18n namespace, e.g. 'Settings.channels.messenger'. */
  translationNamespace: string;
  /** Extra display line under the connected state — Instagram shows
   *  its linked @username; Messenger has nothing extra to show. */
  renderConnectedExtra?: (status: MetaChannelConnectionStatus) => React.ReactNode;
}

/**
 * Shared "Connect with Facebook" OAuth panel for Messenger and
 * Instagram (migration 055) — both channels' Settings UI is otherwise
 * identical (status fetch, connect/disconnect, reauth banner, Page
 * picker), so this one component drives both rather than forking the
 * same ~150 lines twice.
 */
export function MetaChannelPanel({
  channel,
  translationNamespace,
  renderConnectedExtra,
}: MetaChannelPanelProps) {
  const t = useTranslations(translationNamespace);
  const { user, accountId, loading: authLoading, profileLoading, canEditSettings } = useAuth();
  const searchParams = useSearchParams();

  const base = `/api/account/channels/${channel}`;

  const [status, setStatus] = useState<MetaChannelConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [disconnecting, setDisconnecting] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);

  const [pagePicker, setPagePicker] = useState<{ connectionId: string; pages: MetaPage[] } | null>(
    null,
  );
  const [selecting, setSelecting] = useState(false);

  // Webhook verify token — write-only, same self-service pattern as
  // WhatsApp's (src/app/api/whatsapp/config/route.ts): GET never echoes
  // it back, so this field starts blank on every load regardless of
  // whether one was set before.
  const [verifyToken, setVerifyToken] = useState('');
  const [savingVerifyToken, setSavingVerifyToken] = useState(false);
  const webhookUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/api/${channel}/webhook` : '';

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success(t('webhookCopied'));
  }

  async function handleSaveVerifyToken() {
    if (!verifyToken.trim()) return;
    setSavingVerifyToken(true);
    try {
      const res = await fetch(base, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ verify_token: verifyToken.trim() }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error || t('verifyTokenSaveFailed'));
        return;
      }
      toast.success(t('verifyTokenSaved'));
    } catch (err) {
      console.error(`[${channel}-channel] verify token save error:`, err);
      toast.error(t('verifyTokenSaveFailed'));
    } finally {
      setSavingVerifyToken(false);
    }
  }

  const fetchStatus = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(base);
      const data = await res.json();
      if (res.ok) setStatus(data);
    } catch (err) {
      console.error(`[${channel}-channel] fetch error:`, err);
    } finally {
      setLoading(false);
    }
  }, [base, channel]);

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

  // React to the OAuth callback's redirect query params — only once
  // per param set, since this panel stays mounted while its sub-nav tab
  // is active.
  const handledParamsRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchParams.get('channel') !== channel) return;
    const key = searchParams.toString();
    if (handledParamsRef.current === key) return;
    handledParamsRef.current = key;

    if (searchParams.get('connected') === '1') {
      toast.success(t('connected'));
      fetchStatus();
    } else if (searchParams.get('oauth_error')) {
      const code = searchParams.get('oauth_error') ?? 'unknown';
      const known = ['invalid_state', 'no_pages', 'no_ig_account', 'denied'].includes(code)
        ? code
        : 'unknown';
      toast.error(t(`oauthError.${known}`));
    } else if (searchParams.get('oauth') === 'select_page') {
      const connectionId = searchParams.get('connection_id');
      if (connectionId) {
        fetch(`${base}/oauth/pages?connection_id=${encodeURIComponent(connectionId)}`)
          .then((res) => res.json())
          .then((data) => setPagePicker({ connectionId, pages: data.pages ?? [] }))
          .catch((err) => console.error(`[${channel}-channel] pages fetch error:`, err));
      }
    }
  }, [searchParams, channel, base, t, fetchStatus]);

  async function selectPage(pageId: string) {
    if (!pagePicker) return;
    setSelecting(true);
    try {
      const res = await fetch(`${base}/oauth/finalize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: pagePicker.connectionId, page_id: pageId }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('connectFailed'));
        return;
      }
      toast.success(t('connected'));
      setPagePicker(null);
      fetchStatus();
    } catch (err) {
      console.error(`[${channel}-channel] finalize error:`, err);
      toast.error(t('connectFailed'));
    } finally {
      setSelecting(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm(t('disconnectConfirmDescription'))) return;
    setDisconnecting(true);
    try {
      const res = await fetch(base, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        toast.error(data?.error || t('disconnectFailed'));
        return;
      }
      setStatus({ connected: false, needs_reauth: false, status: 'disconnected' });
      toast.success(t('disconnected'));
    } catch (err) {
      console.error(`[${channel}-channel] disconnect error:`, err);
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

      {pagePicker ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">{t('pageSelectTitle')}</CardTitle>
            <CardDescription>{t('pageSelectDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {pagePicker.pages.map((page) => (
              <Button
                key={page.id}
                variant="outline"
                className="w-full justify-start"
                disabled={selecting}
                onClick={() => selectPage(page.id)}
              >
                {selecting ? <Loader2 className="size-4 animate-spin" /> : null}
                {page.name}
              </Button>
            ))}
          </CardContent>
        </Card>
      ) : status?.needs_reauth ? (
        <Card className="mb-6 border-amber-500/30 bg-amber-500/10">
          <CardContent className="flex items-center justify-between gap-4 py-4">
            <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
              <AlertTriangle className="size-4 shrink-0" />
              {t('reauthBanner')}
            </div>
            {canEditSettings ? (
              <a href={`${base}/oauth/start`} className={buttonVariants({ size: 'sm' })}>
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
                  {t('connectedAs', { name: status.page_name ?? '' })}
                </p>
                {renderConnectedExtra ? renderConnectedExtra(status) : null}
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
                <a href={`${base}/oauth/start`} className={buttonVariants({})}>
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
            <CardTitle className="text-base">{t('webhookTitle')}</CardTitle>
            <CardDescription>{t('webhookDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('webhookUrlLabel')}</Label>
              <div className="flex gap-2">
                <Input
                  readOnly
                  value={webhookUrl}
                  className="bg-muted border-border text-muted-foreground font-mono text-sm"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={handleCopyWebhookUrl}
                  className="shrink-0"
                >
                  <Copy className="size-4" />
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">{t('verifyTokenLabel')}</Label>
              <div className="flex gap-2">
                <Input
                  placeholder={t('verifyTokenPlaceholder')}
                  value={verifyToken}
                  onChange={(e) => setVerifyToken(e.target.value)}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
                {canEditSettings ? (
                  <Button
                    type="button"
                    onClick={handleSaveVerifyToken}
                    disabled={savingVerifyToken || !verifyToken.trim()}
                    className="shrink-0"
                  >
                    {savingVerifyToken ? <Loader2 className="size-4 animate-spin" /> : null}
                    {t('verifyTokenSave')}
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">{t('verifyTokenHint')}</p>
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
