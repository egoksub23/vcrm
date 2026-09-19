'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/** Add or remove sample comments so the Comments inbox can be tried (or
 *  shown to the team) before any account is connected. */
export function CommentsSamplesCard() {
  const t = useTranslations('Settings.channels.comments');
  const [busy, setBusy] = useState<'add' | 'clear' | null>(null);

  async function run(kind: 'add' | 'clear') {
    setBusy(kind);
    try {
      const res = await fetch('/api/comments/test', { method: kind === 'add' ? 'POST' : 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error ?? t('sampleFailed'));
        return;
      }
      toast.success(kind === 'add' ? t('sampleAdded') : t('sampleCleared'));
    } catch {
      toast.error(t('sampleFailed'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="text-base">{t('sampleTitle')}</CardTitle>
        <CardDescription>{t('sampleDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => void run('add')} disabled={busy !== null}>
          {busy === 'add' ? <Loader2 className="size-4 animate-spin" /> : null}
          {t('sampleAdd')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void run('clear')} disabled={busy !== null}>
          {busy === 'clear' ? <Loader2 className="size-4 animate-spin" /> : null}
          {t('sampleClear')}
        </Button>
      </CardContent>
    </Card>
  );
}
