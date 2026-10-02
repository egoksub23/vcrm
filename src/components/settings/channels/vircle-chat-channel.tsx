'use client';

// ============================================================
// Settings, Channels, Vircle Chat.
//
// The Vircle mobile app's in-app customer chat, carried by an external
// gateway (docs/vircle-chat-contract.md, docs/vircle-chat-setup.md). There is
// no OAuth: an admin types the gateway's address, Halo generates the three
// values the gateway team needs (workspace key, signing secret, API token),
// and the two secrets are shown exactly once.
//
// Only rendered when the operator's `vircle_chat` flag is on for the
// workspace (channels-tab.tsx decides; the routes enforce it again).
// ============================================================

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, Copy, Loader2, PlugZap, RefreshCw, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth, useCapability } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { SettingsPanelHead } from '../settings-panel-head';
import { ChannelEnabledSwitch } from './channel-enabled-switch';
import type { VircleChatConfigView } from '@/lib/vircle-chat/config';

const BASE = '/api/account/channels/vircle-chat';

interface ConnectionState {
  featureEnabled: boolean;
  configured: boolean;
  config: VircleChatConfigView | null;
  webhookUrl: string;
}

/** The two secrets, in plaintext, for as long as this screen keeps them (never reloaded from the server). */
interface Revealed {
  signingSecret?: string;
  apiToken?: string;
}

type Confirming = 'secret' | 'token' | 'disconnect' | null;

async function readJson<T>(res: Response): Promise<T & { error?: string }> {
  return (await res.json().catch(() => ({}))) as T & { error?: string };
}

export function VircleChatChannel() {
  const t = useTranslations('Settings.channels.vircleChat');
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();
  const canManage = useCapability('channels.manage');

  const [state, setState] = useState<ConnectionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [gatewayUrl, setGatewayUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null);
  const [pushSaving, setPushSaving] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchState = useCallback(async () => {
    setLoading(true);
    setLoadFailed(false);
    try {
      const res = await fetch(BASE);
      if (!res.ok) {
        setLoadFailed(true);
        return;
      }
      const data = (await res.json()) as ConnectionState;
      setState(data);
      if (data.config) setGatewayUrl(data.config.gatewayBaseUrl);
    } catch (err) {
      console.error('[vircle-chat-channel] fetch error:', err);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!user || !accountId || !canManage) {
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchState();
  }, [authLoading, profileLoading, user, accountId, canManage, fetchState]);

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch(BASE, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gateway_base_url: gatewayUrl }),
      });
      const data = await readJson<ConnectionState & { secrets?: { signingSecret: string; apiToken: string } }>(res);
      if (!res.ok) {
        toast.error(data.error || t('saveFailed'));
        return;
      }
      setState((prev) => ({
        featureEnabled: true,
        configured: true,
        config: data.config,
        webhookUrl: data.webhookUrl ?? prev?.webhookUrl ?? '',
      }));
      if (data.config) setGatewayUrl(data.config.gatewayBaseUrl);
      if (data.secrets) {
        setRevealed({ signingSecret: data.secrets.signingSecret, apiToken: data.secrets.apiToken });
        toast.success(t('connected'));
      } else {
        toast.success(t('saved'));
      }
      setTestResult(null);
    } catch (err) {
      console.error('[vircle-chat-channel] save error:', err);
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleRotate(which: 'secret' | 'token') {
    setBusy(true);
    try {
      const res = await fetch(`${BASE}/${which}`, { method: 'POST' });
      const data = await readJson<{ signingSecret?: string; apiToken?: string }>(res);
      const value = which === 'secret' ? data.signingSecret : data.apiToken;
      if (!res.ok || !value) {
        toast.error(data.error || t('rotateFailed'));
        return;
      }
      setRevealed((prev) => ({ ...prev, ...(which === 'secret' ? { signingSecret: value } : { apiToken: value }) }));
      setConfirming(null);
      toast.success(which === 'secret' ? t('secretRotated') : t('tokenRotated'));
    } catch (err) {
      console.error('[vircle-chat-channel] rotate error:', err);
      toast.error(t('rotateFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${BASE}/test`, { method: 'POST' });
      const data = await readJson<{ ok?: boolean }>(res);
      setTestResult(res.ok ? { ok: !!data.ok, error: data.error } : { ok: false, error: data.error });
    } catch (err) {
      console.error('[vircle-chat-channel] test error:', err);
      setTestResult({ ok: false });
    } finally {
      setTesting(false);
    }
  }

  async function handlePushToggle(next: boolean) {
    const previous = state?.config?.pushAlertsEnabled ?? false;
    setState((prev) => (prev?.config ? { ...prev, config: { ...prev.config, pushAlertsEnabled: next } } : prev));
    setPushSaving(true);
    try {
      const res = await fetch(BASE, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ push_alerts_enabled: next }),
      });
      if (!res.ok) throw new Error(`PATCH failed: ${res.status}`);
    } catch (err) {
      console.error('[vircle-chat-channel] push toggle error:', err);
      setState((prev) =>
        prev?.config ? { ...prev, config: { ...prev.config, pushAlertsEnabled: previous } } : prev,
      );
      toast.error(t('pushToggleFailed'));
    } finally {
      setPushSaving(false);
    }
  }

  async function handleDisconnect() {
    setBusy(true);
    try {
      const res = await fetch(BASE, { method: 'DELETE' });
      if (!res.ok) {
        const data = await readJson<object>(res);
        toast.error(data.error || t('disconnectFailed'));
        return;
      }
      setState((prev) => (prev ? { ...prev, configured: false, config: null } : prev));
      setRevealed(null);
      setTestResult(null);
      setGatewayUrl('');
      setConfirming(null);
      toast.success(t('disconnected'));
    } catch (err) {
      console.error('[vircle-chat-channel] disconnect error:', err);
      toast.error(t('disconnectFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) {
    return (
      <div>
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <Card>
          <CardContent className="py-5 text-sm text-muted-foreground">{t('needsPermission')}</CardContent>
        </Card>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  if (loadFailed || !state) {
    return (
      <div>
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <Card>
          <CardContent className="flex items-center justify-between gap-4 py-5">
            <p className="text-sm text-muted-foreground">{t('loadFailed')}</p>
            <Button variant="outline" size="sm" onClick={() => void fetchState()}>
              {t('retry')}
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!state.featureEnabled) {
    return (
      <div>
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <Card>
          <CardContent className="py-5 text-sm text-muted-foreground">{t('notEnabled')}</CardContent>
        </Card>
      </div>
    );
  }

  const config = state.config;

  return (
    <div>
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          config ? (
            <ChannelEnabledSwitch
              enabled={config.enabled}
              onChange={(next) =>
                setState((prev) => (prev?.config ? { ...prev, config: { ...prev.config, enabled: next } } : prev))
              }
              patchUrl={BASE}
              idPrefix="vircle-chat"
            />
          ) : undefined
        }
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('gatewayTitle')}</CardTitle>
          <CardDescription>{t('gatewayDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          <Label htmlFor="vircle-chat-gateway" className="text-muted-foreground">
            {t('gatewayLabel')}
          </Label>
          <div className="flex gap-2">
            <Input
              id="vircle-chat-gateway"
              value={gatewayUrl}
              onChange={(e) => setGatewayUrl(e.target.value)}
              placeholder={t('gatewayPlaceholder')}
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              className="font-mono text-sm"
            />
            <Button onClick={() => void handleSave()} disabled={saving || !gatewayUrl.trim()} className="shrink-0">
              {saving ? <Loader2 className="size-4 animate-spin" /> : config ? null : <PlugZap className="size-4" />}
              {config ? t('save') : t('saveAndConnect')}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">{t('gatewayHint')}</p>
        </CardContent>
      </Card>

      {config ? (
        <>
          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="text-base">{t('detailsTitle')}</CardTitle>
              <CardDescription>{t('detailsDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
              {revealed ? (
                <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                  <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                    {t('revealedTitle')}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t('revealedHint')}</p>
                  <Button variant="ghost" size="sm" className="mt-2" onClick={() => setRevealed(null)}>
                    {t('revealedDone')}
                  </Button>
                </div>
              ) : null}

              <ValueRow
                label={t('workspaceKeyLabel')}
                hint={t('workspaceKeyHint')}
                value={config.workspaceKey}
                copyLabel={t('copy')}
                onCopy={() => void copy(config.workspaceKey)}
              />
              <ValueRow
                label={t('webhookUrlLabel')}
                hint={t('webhookUrlHint')}
                value={state.webhookUrl}
                copyLabel={t('copy')}
                onCopy={() => void copy(state.webhookUrl)}
              />
              <ValueRow
                label={t('signingSecretLabel')}
                hint={t('signingSecretHint')}
                value={revealed?.signingSecret ?? null}
                hiddenText={t('secretHidden')}
                copyLabel={t('copy')}
                onCopy={() => revealed?.signingSecret && void copy(revealed.signingSecret)}
                action={
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirming('secret')}>
                    <RefreshCw className="size-3.5" />
                    {t('rotateSecret')}
                  </Button>
                }
              />
              <ValueRow
                label={t('apiTokenLabel')}
                hint={t('apiTokenHint')}
                value={revealed?.apiToken ?? null}
                hiddenText={t('secretHidden')}
                copyLabel={t('copy')}
                onCopy={() => revealed?.apiToken && void copy(revealed.apiToken)}
                action={
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirming('token')}>
                    <RefreshCw className="size-3.5" />
                    {t('rotateToken')}
                  </Button>
                }
              />
            </CardContent>
          </Card>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle className="text-base">{t('statusTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {!config.enabled ? (
                <p className="flex items-center gap-2 rounded-md bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="size-3.5 shrink-0" />
                  {t('pausedNotice')}
                </p>
              ) : null}

              <dl className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-xs text-muted-foreground">{t('lastInboundLabel')}</dt>
                  <dd className="mt-0.5 text-foreground">
                    {config.lastInboundAt ? new Date(config.lastInboundAt).toLocaleString() : t('neverReceived')}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t('lastErrorLabel')}</dt>
                  <dd className="mt-0.5 break-words text-foreground">{config.lastError ?? t('noError')}</dd>
                </div>
              </dl>

              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" size="sm" onClick={() => void handleTest()} disabled={testing}>
                  {testing ? <Loader2 className="size-4 animate-spin" /> : <PlugZap className="size-4" />}
                  {t('testConnection')}
                </Button>
                {testResult ? (
                  testResult.ok ? (
                    <span className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                      <CheckCircle2 className="size-4" />
                      {t('testOk')}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5 text-sm text-destructive">
                      <XCircle className="size-4 shrink-0" />
                      {testResult.error ? t('testFailedWith', { error: testResult.error }) : t('testFailed')}
                    </span>
                  )
                ) : null}
              </div>

              <div className="flex items-start justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
                <div className="min-w-0">
                  <Label htmlFor="vircle-chat-push" className="text-sm font-medium text-foreground">
                    {t('pushLabel')}
                  </Label>
                  <p className="mt-0.5 text-xs text-muted-foreground">{t('pushHint')}</p>
                </div>
                <Switch
                  id="vircle-chat-push"
                  checked={config.pushAlertsEnabled}
                  onCheckedChange={(next) => void handlePushToggle(next)}
                  disabled={pushSaving}
                />
              </div>

              <div className="flex justify-end">
                <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirming('disconnect')}>
                  {t('disconnect')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      ) : null}

      <Dialog open={confirming !== null} onOpenChange={(open) => !open && !busy && setConfirming(null)}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              {confirming === 'secret'
                ? t('rotateSecretTitle')
                : confirming === 'token'
                  ? t('rotateTokenTitle')
                  : t('disconnectTitle')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {confirming === 'secret'
                ? t('rotateSecretBody')
                : confirming === 'token'
                  ? t('rotateTokenBody')
                  : t('disconnectBody')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirming(null)}>
              {t('cancel')}
            </Button>
            {confirming === 'disconnect' ? (
              <Button variant="destructive" disabled={busy} onClick={() => void handleDisconnect()}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t('disconnectConfirm')}
              </Button>
            ) : (
              <Button disabled={busy} onClick={() => void handleRotate(confirming === 'token' ? 'token' : 'secret')}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {t('rotateConfirm')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * One value the gateway team needs. A public value is always shown; a secret
 * is shown only while this screen still holds it (`value` null = hidden).
 */
function ValueRow({
  label,
  hint,
  value,
  hiddenText,
  copyLabel,
  onCopy,
  action,
}: {
  label: string;
  hint: string;
  value: string | null;
  hiddenText?: string;
  copyLabel: string;
  onCopy: () => void;
  action?: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-3">
        <Label className="text-muted-foreground">{label}</Label>
        {action}
      </div>
      {value !== null ? (
        <div className="flex gap-2">
          <Input readOnly value={value} className="border-border bg-muted font-mono text-sm text-foreground" />
          <Button type="button" variant="outline" size="icon" onClick={onCopy} className="shrink-0" aria-label={copyLabel}>
            <Copy className="size-4" />
          </Button>
        </div>
      ) : (
        <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
          {hiddenText}
        </p>
      )}
      <p className="text-xs text-muted-foreground">{hint}</p>
    </div>
  );
}
