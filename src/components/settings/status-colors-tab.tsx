'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SwatchBook, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { createClient } from '@/lib/supabase/client';
import { useAuth, useCapability } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { SettingsPanelHead } from './settings-panel-head';
import { cn } from '@/lib/utils';
import {
  DEFAULT_STATUS_COLORS,
  STATUS_COLOR_SWATCHES,
  type StatusColors,
} from '@/lib/status-colors';

interface ColorFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}

function ColorField({ label, value, onChange, disabled }: ColorFieldProps) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className="size-6 shrink-0 rounded-full border border-border"
          style={{ backgroundColor: value }}
          aria-hidden="true"
        />
        <span className="mr-1 h-4 w-px shrink-0 bg-border" aria-hidden="true" />
        {STATUS_COLOR_SWATCHES.map((swatch) => (
          <button
            key={swatch}
            type="button"
            disabled={disabled}
            onClick={() => onChange(swatch)}
            aria-label={swatch}
            aria-pressed={value.toLowerCase() === swatch.toLowerCase()}
            className={cn(
              'size-5 shrink-0 rounded-full transition-transform hover:scale-110 disabled:pointer-events-none disabled:opacity-50',
              value.toLowerCase() === swatch.toLowerCase() &&
                'outline outline-2 outline-offset-2 outline-primary',
            )}
            style={{ backgroundColor: swatch }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * Settings → Status colors. Drives the Inbox's conversation-status dot,
 * the SLA-breached "overdue" pill, and the priority flag — all three
 * used to be hardcoded Tailwind classes in conversation-list.tsx, now
 * read from `accounts.status_colors` (migration 057) via `useAuth()`.
 * Writes go straight to that column, same pattern as
 * `ResponseTimeSettings`'s `sla_response_minutes` — the `accounts_update`
 * RLS policy (017) already restricts it to admins+.
 */
export function StatusColorsTab() {
  const supabase = createClient();
  const { accountId, statusColors, profileLoading, refreshProfile } = useAuth();
  const canEditWorkspace = useCapability('settings.workspace');
  const t = useTranslations('Settings.statusColors');

  const [colors, setColors] = useState<StatusColors>(statusColors);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setColors(statusColors);
  }, [statusColors]);

  const dirty = JSON.stringify(colors) !== JSON.stringify(statusColors);
  const disabled = !canEditWorkspace || profileLoading;

  function setField(field: 'open' | 'pending' | 'closed' | 'overdue', value: string) {
    setColors((prev) => ({ ...prev, [field]: value }));
  }
  function setPriorityField(field: keyof StatusColors['priority'], value: string) {
    setColors((prev) => ({ ...prev, priority: { ...prev.priority, [field]: value } }));
  }

  async function handleSave() {
    if (!accountId || !dirty) return;
    setSaving(true);
    const { error } = await supabase
      .from('accounts')
      .update({ status_colors: colors })
      .eq('id', accountId);
    if (error) {
      toast.error(t('saveFailed'));
      setSaving(false);
      return;
    }
    await refreshProfile();
    setSaving(false);
    toast.success(t('saveSuccess'));
  }

  return (
    <section className="max-w-2xl animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-foreground">
            <SwatchBook className="size-4 text-primary" />
            {t('statusSectionTitle')}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('statusSectionDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <ColorField label={t('open')} value={colors.open} onChange={(v) => setField('open', v)} disabled={disabled} />
          <ColorField label={t('pending')} value={colors.pending} onChange={(v) => setField('pending', v)} disabled={disabled} />
          <ColorField label={t('closed')} value={colors.closed} onChange={(v) => setField('closed', v)} disabled={disabled} />
          <ColorField label={t('overdue')} value={colors.overdue} onChange={(v) => setField('overdue', v)} disabled={disabled} />
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-foreground">{t('prioritySectionTitle')}</CardTitle>
          <CardDescription className="text-muted-foreground">
            {t('prioritySectionDesc')}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <ColorField
            label={t('priorityUrgent')}
            value={colors.priority.urgent}
            onChange={(v) => setPriorityField('urgent', v)}
            disabled={disabled}
          />
          <ColorField
            label={t('priorityHigh')}
            value={colors.priority.high}
            onChange={(v) => setPriorityField('high', v)}
            disabled={disabled}
          />
          <ColorField
            label={t('priorityNormal')}
            value={colors.priority.normal}
            onChange={(v) => setPriorityField('normal', v)}
            disabled={disabled}
          />
          <ColorField
            label={t('priorityLow')}
            value={colors.priority.low}
            onChange={(v) => setPriorityField('low', v)}
            disabled={disabled}
          />
        </CardContent>
      </Card>

      {!canEditWorkspace && (
        <p className="mt-4 text-xs text-muted-foreground">{t('adminOnlyHint')}</p>
      )}

      {canEditWorkspace && (
        <div className="mt-6 flex items-center gap-2">
          <Button
            onClick={handleSave}
            disabled={saving || !dirty}
            className="bg-primary text-primary-foreground hover:bg-primary/90"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('saving')}
              </>
            ) : (
              t('save')
            )}
          </Button>
          <Button variant="outline" onClick={() => setColors(DEFAULT_STATUS_COLORS)} disabled={saving}>
            {t('resetToDefaults')}
          </Button>
        </div>
      )}
    </section>
  );
}
