'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, Plus, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { useAuth } from '@/hooks/use-auth';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { SettingsPanelHead } from '../settings-panel-head';
import type { WebWidgetConfig } from '@/types';

const PRESET_COLORS = [
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#10b981',
  '#06b6d4',
];

function widgetOrigin(): string {
  if (typeof window === 'undefined') return 'https://crm.vircle.tech';
  return window.location.origin;
}

export function WebWidgetChannel() {
  const t = useTranslations('Settings.channels.webWidget');
  const { user, accountId, loading: authLoading, profileLoading, canEditSettings } = useAuth();

  const [config, setConfig] = useState<WebWidgetConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);

  const [name, setName] = useState('Website chat');
  const [welcomeMessage, setWelcomeMessage] = useState('Hi there! How can we help?');
  const [primaryColor, setPrimaryColor] = useState(PRESET_COLORS[0]);
  const [position, setPosition] = useState<'left' | 'right'>('right');
  const [enabled, setEnabled] = useState(true);
  const [allowedOrigins, setAllowedOrigins] = useState<string[]>([]);
  const [originInput, setOriginInput] = useState('');

  const applyConfig = useCallback((c: WebWidgetConfig | null) => {
    setConfig(c);
    if (!c) return;
    setName(c.name);
    setWelcomeMessage(c.welcome_message);
    setPrimaryColor(c.primary_color);
    setPosition(c.position);
    setEnabled(c.enabled);
    setAllowedOrigins(c.allowed_origins);
  }, []);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/account/channels/web-widget');
      const data = await res.json();
      if (res.ok) applyConfig(data.config);
    } catch (err) {
      console.error('[web-widget-channel] fetch error:', err);
    } finally {
      setLoading(false);
    }
  }, [applyConfig]);

  useEffect(() => {
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchConfig();
  }, [authLoading, profileLoading, user, accountId, fetchConfig]);

  function addOrigin() {
    const trimmed = originInput.trim();
    if (!trimmed) return;
    try {
      const url = new URL(trimmed);
      const origin = url.origin;
      if (!allowedOrigins.includes(origin)) {
        setAllowedOrigins((prev) => [...prev, origin]);
      }
      setOriginInput('');
    } catch {
      toast.error(t('invalidOrigin'));
    }
  }

  function removeOrigin(origin: string) {
    setAllowedOrigins((prev) => prev.filter((o) => o !== origin));
  }

  async function handleSave() {
    if (!canEditSettings) return;
    setSaving(true);
    try {
      const res = await fetch('/api/account/channels/web-widget', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          welcome_message: welcomeMessage,
          primary_color: primaryColor,
          position,
          enabled,
          allowed_origins: allowedOrigins,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || t('saveFailed'));
        return;
      }
      applyConfig(data.config);
      toast.success(t('saved'));
    } catch (err) {
      console.error('[web-widget-channel] save error:', err);
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function copySnippet() {
    if (!config) return;
    const snippet = `<script src="${widgetOrigin()}/widget/loader.js" data-widget-token="${config.widget_token}" async></script>`;
    try {
      await navigator.clipboard.writeText(snippet);
      toast.success(t('snippetCopied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  const embedSnippet = config
    ? `<script src="${widgetOrigin()}/widget/loader.js" data-widget-token="${config.widget_token}" async></script>`
    : null;

  return (
    <div>
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <div className="flex items-center gap-2">
            <Label htmlFor="widget-enabled" className="text-sm text-muted-foreground">
              {enabled ? t('enabled') : t('disabled')}
            </Label>
            <Switch
              id="widget-enabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              disabled={!canEditSettings}
            />
          </div>
        }
      />

      {embedSnippet ? (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="text-base">{t('embedTitle')}</CardTitle>
            <CardDescription>{t('embedDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-muted px-3 py-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-xs text-foreground">
                {embedSnippet}
              </code>
              <Button variant="outline" size="sm" onClick={copySnippet} className="shrink-0">
                <Copy className="size-3.5" />
                {t('copy')}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="mb-6">
          <CardContent className="py-4 text-sm text-muted-foreground">
            {t('saveToGetSnippet')}
          </CardContent>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">{t('appearanceTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <Label htmlFor="widget-name">{t('nameLabel')}</Label>
            <Input
              id="widget-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!canEditSettings}
              maxLength={80}
              className="mt-1.5"
            />
          </div>

          <div>
            <Label htmlFor="widget-welcome">{t('welcomeLabel')}</Label>
            <Textarea
              id="widget-welcome"
              value={welcomeMessage}
              onChange={(e) => setWelcomeMessage(e.target.value)}
              disabled={!canEditSettings}
              maxLength={300}
              rows={2}
              className="mt-1.5"
            />
          </div>

          <div>
            <Label>{t('colorLabel')}</Label>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {PRESET_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  disabled={!canEditSettings}
                  onClick={() => setPrimaryColor(color)}
                  aria-label={color}
                  aria-pressed={primaryColor === color}
                  style={{ backgroundColor: color }}
                  className={cn(
                    'size-7 rounded-md transition-transform hover:scale-110 disabled:opacity-50',
                    primaryColor === color &&
                      'outline outline-2 outline-offset-2 outline-primary',
                  )}
                />
              ))}
            </div>
          </div>

          <div>
            <Label>{t('positionLabel')}</Label>
            <div className="mt-1.5 flex gap-2">
              {(['left', 'right'] as const).map((p) => (
                <button
                  key={p}
                  type="button"
                  disabled={!canEditSettings}
                  onClick={() => setPosition(p)}
                  className={cn(
                    'rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50',
                    position === p
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted',
                  )}
                >
                  {t(`position.${p}`)}
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">{t('originsTitle')}</CardTitle>
          <CardDescription>{t('originsDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2">
            <Input
              value={originInput}
              onChange={(e) => setOriginInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addOrigin();
                }
              }}
              placeholder="https://example.com"
              disabled={!canEditSettings}
            />
            <Button variant="outline" onClick={addOrigin} disabled={!canEditSettings}>
              <Plus className="size-4" />
            </Button>
          </div>
          {allowedOrigins.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {allowedOrigins.map((origin) => (
                <span
                  key={origin}
                  className="flex items-center gap-1.5 rounded-full border border-border bg-muted px-3 py-1 text-xs text-foreground"
                >
                  {origin}
                  {canEditSettings ? (
                    <button type="button" onClick={() => removeOrigin(origin)}>
                      <X className="size-3" />
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">{t('noOriginsRestriction')}</p>
          )}
        </CardContent>
      </Card>

      {canEditSettings ? (
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('save')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
