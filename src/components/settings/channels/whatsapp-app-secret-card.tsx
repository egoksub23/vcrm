'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useCapability } from '@/hooks/use-can';

/**
 * Optional: the Meta App Secret of a Meta app that belongs to THIS
 * workspace (migration 136). Only needed when the WhatsApp number is
 * subscribed to such an app rather than to the operator's own. A delivery
 * signed with it is accepted for this workspace's number only.
 */
export function WhatsAppAppSecretCard() {
  const t = useTranslations('Settings.whatsapp');
  const canManage = useCapability('channels.manage');
  const [stored, setStored] = useState<boolean | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/whatsapp/app-secret', { cache: 'no-store' });
      if (res.ok) setStored(Boolean(((await res.json()) as { has_app_secret?: boolean }).has_app_secret));
    } catch {
      // leave the state unknown; the card still lets the admin save
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch on mount
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    try {
      const res = await fetch('/api/whatsapp/app-secret', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_secret: secret }),
      });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        toast.error(data?.error ?? t('appSecretFailed'));
        return;
      }
      setSecret('');
      setStored(true);
      toast.success(t('appSecretSaved'));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      const res = await fetch('/api/whatsapp/app-secret', { method: 'DELETE' });
      if (!res.ok) {
        toast.error(t('appSecretFailed'));
        return;
      }
      setStored(false);
      toast.success(t('appSecretRemoved'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t('appSecretTitle')}</CardTitle>
        <CardDescription className="text-muted-foreground">{t('appSecretDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {stored !== null && (
          <p className="text-sm text-muted-foreground">{stored ? t('appSecretStored') : t('appSecretNone')}</p>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="wa-app-secret" className="text-muted-foreground">
            {t('appSecretLabel')}
          </Label>
          <div className="flex gap-2">
            <Input
              id="wa-app-secret"
              type="password"
              autoComplete="off"
              placeholder={t('appSecretPlaceholder')}
              value={secret}
              disabled={!canManage || busy}
              onChange={(e) => setSecret(e.target.value)}
            />
            <Button disabled={!canManage || busy || !secret.trim()} onClick={() => void save()}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('appSecretSave')}
            </Button>
            {stored && (
              <Button variant="outline" disabled={!canManage || busy} onClick={() => void remove()}>
                {t('appSecretRemove')}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
