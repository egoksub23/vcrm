'use client';

// ============================================================
// Settings, Channels, Web Widget: the "In-app identity" card and the
// verification-mode selector (Web Widget v2).
//
// In-app identity: the host app's OWN backend signs a short token for its
// signed-in user with a per-workspace secret; the widget then treats that
// visitor as "verified". This card generates / rotates that secret (shown
// exactly once), and shows copy-paste snippets for Node, PHP and Python.
//
// Verification mode: how a visitor's TYPED identity could be confirmed on the
// web. Only "none" works today; the code-based modes are stored options
// shown as "coming soon".
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { Copy, KeyRound, Loader2, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  IDENTIFY_LATE_SNIPPET,
  IDENTITY_SNIPPETS,
  IDENTITY_SNIPPET_LANGUAGES,
  embedWithTokenSnippet,
  type SnippetLanguage,
} from '@/lib/widget/snippets';
import type { WebWidgetConfig } from '@/types';

type VerificationMode = NonNullable<WebWidgetConfig['verification_mode']>;

const MODES: { id: VerificationMode; available: boolean }[] = [
  { id: 'none', available: true },
  { id: 'email_code', available: false },
  { id: 'whatsapp_code', available: false },
];

export function VerificationModeCard({
  value,
  onChange,
  canManage,
}: {
  value: VerificationMode;
  onChange: (mode: VerificationMode) => void;
  canManage: boolean;
}) {
  const t = useTranslations('Settings.channels.webWidget.verification');
  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {MODES.map((m) => {
          const selected = value === m.id;
          return (
            <label
              key={m.id}
              className={cn(
                'flex items-start gap-3 rounded-lg border px-3 py-2.5 text-sm',
                selected ? 'border-primary bg-primary/5' : 'border-border',
                !m.available && 'opacity-60',
              )}
            >
              <input
                type="radio"
                name="widget-verification-mode"
                className="mt-1"
                checked={selected}
                disabled={!m.available || !canManage}
                onChange={() => onChange(m.id)}
              />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 font-medium text-foreground">
                  {t(`modes.${m.id}.label`)}
                  {!m.available ? (
                    <Badge variant="outline" className="text-[10px]">
                      {t('comingSoon')}
                    </Badge>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{t(`modes.${m.id}.hint`)}</span>
              </span>
            </label>
          );
        })}
      </CardContent>
    </Card>
  );
}

async function copyText(text: string, ok: string, fail: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(ok);
  } catch {
    toast.error(fail);
  }
}

function CodeBlock({ code, onCopy, copyLabel }: { code: string; onCopy: () => void; copyLabel: string }) {
  return (
    <div className="relative rounded-lg border border-border bg-muted">
      <Button
        variant="outline"
        size="sm"
        onClick={onCopy}
        className="absolute right-2 top-2 h-7 bg-background px-2 text-xs"
      >
        <Copy className="size-3" />
        {copyLabel}
      </Button>
      <pre className="overflow-x-auto p-3 pr-20 text-xs leading-relaxed text-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}

export function InAppIdentityCard({
  config,
  origin,
  canManage,
  onConfigChange,
}: {
  config: WebWidgetConfig | null;
  origin: string;
  canManage: boolean;
  onConfigChange: (patch: Partial<WebWidgetConfig>) => void;
}) {
  const t = useTranslations('Settings.channels.webWidget.identity');
  const tw = useTranslations('Settings.channels.webWidget');
  const [busy, setBusy] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [lang, setLang] = useState<SnippetLanguage>('node');

  const hasSecret = !!config?.identity_secret_last4;

  async function generate() {
    setBusy(true);
    try {
      const res = await fetch('/api/account/channels/web-widget/identity-secret', { method: 'POST' });
      const data = (await res.json().catch(() => ({}))) as {
        secret?: string;
        last4?: string;
        rotated_at?: string;
        error?: string;
      };
      if (!res.ok || !data.secret) {
        toast.error(data.error || t('generateFailed'));
        return;
      }
      setRevealed(data.secret);
      onConfigChange({ identity_secret_last4: data.last4 ?? null, identity_secret_rotated_at: data.rotated_at ?? null });
      setConfirmRotate(false);
    } catch (err) {
      console.error('[web-widget-identity] generate error:', err);
      toast.error(t('generateFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch('/api/account/channels/web-widget/identity-secret', { method: 'DELETE' });
      if (!res.ok) {
        toast.error(t('removeFailed'));
        return;
      }
      setRevealed(null);
      onConfigChange({ identity_secret_last4: null, identity_secret_rotated_at: null });
      setConfirmRemove(false);
      toast.success(t('removed'));
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setBusy(false);
    }
  }

  const copyLabel = tw('copy');
  const copied = tw('snippetCopied');
  const copyFailed = tw('copyFailed');

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {!config ? (
          <p className="text-sm text-muted-foreground">{t('saveFirst')}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
              <div className="min-w-0 text-sm">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  <KeyRound className="size-4 text-muted-foreground" />
                  {hasSecret ? (
                    <>
                      <code className="text-xs">wis_…{config.identity_secret_last4}</code>
                      <Badge variant="outline" className="text-[10px]">
                        {t('active')}
                      </Badge>
                    </>
                  ) : (
                    <span className="text-muted-foreground">{t('noSecret')}</span>
                  )}
                </div>
                {hasSecret && config.identity_secret_rotated_at ? (
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t('rotatedAt', { date: new Date(config.identity_secret_rotated_at).toLocaleString() })}
                  </p>
                ) : null}
              </div>
              {canManage ? (
                <div className="flex items-center gap-2">
                  {hasSecret ? (
                    <>
                      <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirmRotate(true)}>
                        <RefreshCw className="size-3.5" />
                        {t('rotate')}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmRemove(true)}>
                        <Trash2 className="size-3.5" />
                        {t('remove')}
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" disabled={busy} onClick={() => void generate()}>
                      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
                      {t('generate')}
                    </Button>
                  )}
                </div>
              ) : null}
            </div>

            {revealed ? (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="text-sm font-medium text-foreground">{t('revealedTitle')}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('revealedHint')}</p>
                <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-background px-3 py-2">
                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs">{revealed}</code>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => void copyText(revealed, copied, copyFailed)}
                  >
                    <Copy className="size-3.5" />
                    {copyLabel}
                  </Button>
                </div>
                <Button variant="ghost" size="sm" className="mt-2" onClick={() => setRevealed(null)}>
                  {t('hideSecret')}
                </Button>
              </div>
            ) : null}

            <div>
              <h4 className="text-sm font-medium text-foreground">{t('signTitle')}</h4>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('signHint')}</p>
              <div className="mt-2 flex gap-2">
                {IDENTITY_SNIPPET_LANGUAGES.map((l) => (
                  <button
                    key={l}
                    type="button"
                    onClick={() => setLang(l)}
                    className={cn(
                      'rounded-lg border px-3 py-1 text-xs font-medium transition-colors',
                      lang === l
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {t(`lang.${l}`)}
                  </button>
                ))}
              </div>
              <div className="mt-2">
                <CodeBlock
                  code={IDENTITY_SNIPPETS[lang]}
                  copyLabel={copyLabel}
                  onCopy={() => void copyText(IDENTITY_SNIPPETS[lang], copied, copyFailed)}
                />
              </div>
            </div>

            <div>
              <h4 className="text-sm font-medium text-foreground">{t('embedTitle')}</h4>
              <p className="mt-0.5 text-xs text-muted-foreground">{t('embedHint')}</p>
              <div className="mt-2">
                <CodeBlock
                  code={embedWithTokenSnippet(origin, config.widget_token)}
                  copyLabel={copyLabel}
                  onCopy={() =>
                    void copyText(embedWithTokenSnippet(origin, config.widget_token), copied, copyFailed)
                  }
                />
              </div>
              <p className="mt-3 text-xs text-muted-foreground">{t('lateHint')}</p>
              <div className="mt-2">
                <CodeBlock
                  code={IDENTIFY_LATE_SNIPPET}
                  copyLabel={copyLabel}
                  onCopy={() => void copyText(IDENTIFY_LATE_SNIPPET, copied, copyFailed)}
                />
              </div>
            </div>

            <div className="rounded-lg border border-border bg-muted/50 p-3 text-xs text-muted-foreground">
              <p className="font-medium text-foreground">{t('securityTitle')}</p>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                <li>{t('security1')}</li>
                <li>{t('security2')}</li>
                <li>{t('security3')}</li>
                <li>{t('security4')}</li>
              </ul>
            </div>
          </>
        )}
      </CardContent>

      <Dialog open={confirmRotate} onOpenChange={(open) => !open && !busy && setConfirmRotate(false)}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('rotateTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t('rotateBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmRotate(false)}>
              {t('cancel')}
            </Button>
            <Button disabled={busy} onClick={() => void generate()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t('rotateConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmRemove} onOpenChange={(open) => !open && !busy && setConfirmRemove(false)}>
        <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('removeTitle')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">{t('removeBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmRemove(false)}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              {t('removeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
