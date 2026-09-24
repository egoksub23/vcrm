'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

/**
 * The "pause without disconnecting" toggle (migration 097), shown in a
 * connected channel's settings panel header. Unlike the rest of a
 * channel's settings, this saves immediately on click via the channel's
 * own PATCH route rather than waiting on a form-wide Save button —
 * pausing a channel is meant to take effect right away. Reverts
 * optimistically if the write fails.
 *
 * One shared component rather than six near-identical copies: every
 * channel's PATCH route accepts the same `{ enabled }` body and returns
 * the same shape, so the only thing that varies per channel is the URL.
 */
export function ChannelEnabledSwitch({
  enabled,
  onChange,
  patchUrl,
  disabled,
  idPrefix,
}: {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  /** PATCH endpoint accepting `{ enabled: boolean }`, e.g. `/api/whatsapp/config`. */
  patchUrl: string;
  /** Read-only viewer (missing channels.manage) — same gate as Disconnect. */
  disabled?: boolean;
  idPrefix: string;
}) {
  const t = useTranslations('Settings.channels');
  const [saving, setSaving] = useState(false);

  async function handleToggle(next: boolean) {
    onChange(next);
    setSaving(true);
    try {
      const res = await fetch(patchUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) throw new Error(`PATCH ${patchUrl} failed: ${res.status}`);
      toast.success(next ? t('channelEnabled') : t('channelDisabled'));
    } catch (err) {
      console.error('[ChannelEnabledSwitch] toggle failed:', err);
      onChange(!next);
      toast.error(t('channelToggleFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={`${idPrefix}-enabled`} className="text-sm text-muted-foreground">
        {enabled ? t('enabled') : t('disabled')}
      </Label>
      <Switch
        id={`${idPrefix}-enabled`}
        checked={enabled}
        onCheckedChange={handleToggle}
        disabled={disabled || saving}
      />
    </div>
  );
}
