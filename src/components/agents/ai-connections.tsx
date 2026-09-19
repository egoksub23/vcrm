'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, CircleDashed, Loader2, Pencil, Plus, Trash2 } from 'lucide-react';

import { cn } from '@/lib/utils';
import { AI_TASKS, type AiTask } from '@/lib/ai/tasks';
import {
  AI_PRESET_IDS,
  hostOf,
  resolveSelection,
  selectionFromConfig,
  PRESET_KEY_PLACEHOLDER,
  type AiPresetId,
  type KimiRegion,
} from '@/lib/ai/presets';
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults';
import type { AiProvider } from '@/lib/ai/types';
import { formatCompactNumber } from '@/lib/currency';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

type Health = 'untested' | 'ok' | 'error';

interface ConnectionRow {
  id: string;
  name: string;
  provider: AiProvider;
  base_url: string | null;
  model: string;
  health_status: Health;
  health_checked_at: string | null;
  health_error: string | null;
}

interface DefaultRow {
  configured: boolean;
  provider?: AiProvider;
  model?: string;
  base_url?: string | null;
  is_active?: boolean;
  health_status?: Health;
  health_checked_at?: string | null;
  health_error?: string | null;
}

interface RoutingRow {
  task: AiTask;
  connectionId: string | null;
  modelOverride: string | null;
  enabled: boolean;
}

interface Budget {
  budget: number | null;
  used: number;
  fraction: number | null;
  warn: boolean;
  exceeded: boolean;
}

interface Payload {
  default: DefaultRow;
  connections: ConnectionRow[];
  routing: RoutingRow[];
  budget: Budget;
}

const selectClass =
  'h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary/50 disabled:opacity-60';

const PRESET_LABEL: Record<AiPresetId, string> = {
  kimi: 'Kimi (Moonshot)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  deepseek: 'DeepSeek',
  custom: 'Other (OpenAI-compatible)',
};

function serviceLabel(provider: AiProvider | undefined, baseUrl: string | null | undefined): string {
  if (!provider) return '';
  const sel = selectionFromConfig(provider, baseUrl ?? null);
  return sel.preset === 'custom' ? hostOf(baseUrl) || PRESET_LABEL.custom : PRESET_LABEL[sel.preset];
}

function HealthBadge({ status, checkedAt, error }: { status: Health; checkedAt: string | null; error: string | null }) {
  const t = useTranslations('Agents.connections');
  if (status === 'ok') {
    return (
      <span
        className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"
        title={checkedAt ? t('healthCheckedAt', { time: formatDistanceToNow(new Date(checkedAt), { addSuffix: true }) }) : undefined}
      >
        <CheckCircle2 className="h-3.5 w-3.5" /> {t('healthOk')}
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-destructive" title={error ?? undefined}>
        <AlertTriangle className="h-3.5 w-3.5" /> {t('healthError')}
        {error ? <span className="max-w-[16rem] truncate text-muted-foreground">· {error}</span> : null}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <CircleDashed className="h-3.5 w-3.5" /> {t('healthUntested')}
    </span>
  );
}

/**
 * AI Agents → Connections (admin): the account's provider connections, which
 * one each AI job uses (and with which model), and the monthly token budget.
 * The default connection is the one set up on the Setup tab; extra
 * connections let a cheap fast model do the routine jobs and a stronger one
 * the careful replies.
 */
export function AiConnections({ onGoToSetup }: { onGoToSetup: () => void }) {
  const t = useTranslations('Agents.connections');
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [routing, setRouting] = useState<RoutingRow[]>([]);
  const [routingDirty, setRoutingDirty] = useState(false);
  const [savingRouting, setSavingRouting] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [budgetInput, setBudgetInput] = useState('');
  const [savingBudget, setSavingBudget] = useState(false);
  const [dialog, setDialog] = useState<{ key: number; edit: ConnectionRow | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/connections', { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? t('loadFailed'));
        return;
      }
      const p = json as Payload;
      setData(p);
      setRouting(p.routing);
      setRoutingDirty(false);
      setBudgetInput(p.budget.budget ? String(p.budget.budget) : '');
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function test(id: string) {
    setTesting(id);
    try {
      const res = await fetch(`/api/ai/connections/${id}/test`, { method: 'POST' });
      const json = await res.json().catch(() => ({}));
      if (json.ok) toast.success(t('testOk', { ms: json.latency_ms ?? 0 }));
      else toast.error(json.error ?? t('testFailed'));
      void load();
    } catch {
      toast.error(t('testFailed'));
    } finally {
      setTesting(null);
    }
  }

  async function remove(c: ConnectionRow) {
    if (!window.confirm(t('deleteConfirm', { name: c.name }))) return;
    const res = await fetch(`/api/ai/connections/${c.id}`, { method: 'DELETE' });
    if (!res.ok) {
      toast.error(t('deleteFailed'));
      return;
    }
    toast.success(t('deleted'));
    void load();
  }

  async function saveRouting() {
    setSavingRouting(true);
    try {
      const res = await fetch('/api/ai/routing', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          routing: routing.map((r) => ({
            task: r.task,
            connection_id: r.connectionId,
            model_override: r.modelOverride,
            enabled: r.enabled,
          })),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? t('routingFailed'));
        return;
      }
      toast.success(t('routingSaved'));
      setRoutingDirty(false);
    } catch {
      toast.error(t('routingFailed'));
    } finally {
      setSavingRouting(false);
    }
  }

  async function saveBudget(clear = false) {
    setSavingBudget(true);
    try {
      const res = await fetch('/api/ai/budget', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monthly_token_budget: clear || !budgetInput.trim() ? null : Number(budgetInput) }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? t('budgetFailed'));
        return;
      }
      toast.success(t('budgetSaved'));
      void load();
    } catch {
      toast.error(t('budgetFailed'));
    } finally {
      setSavingBudget(false);
    }
  }

  const patchRouting = (task: AiTask, patch: Partial<RoutingRow>) => {
    setRouting((rows) => rows.map((r) => (r.task === task ? { ...r, ...patch } : r)));
    setRoutingDirty(true);
  };

  if (loading || !data) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }

  const def = data.default;
  const budget = data.budget;
  const pct = budget.fraction === null ? 0 : Math.min(100, Math.round(budget.fraction * 100));

  return (
    <div className="space-y-6">
      {/* Budget */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('budgetTitle')}</CardTitle>
          <CardDescription>{t('budgetDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {budget.budget ? (
            <div>
              <div className="flex items-baseline justify-between text-sm">
                <span className="tabular-nums text-foreground">
                  {formatCompactNumber(budget.used)} / {formatCompactNumber(budget.budget)} {t('tokens')}
                </span>
                <span
                  className={cn(
                    'text-xs font-medium',
                    budget.exceeded ? 'text-destructive' : budget.warn ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground',
                  )}
                >
                  {budget.exceeded ? t('budgetExceeded') : budget.warn ? t('budgetWarn', { pct }) : t('budgetPct', { pct })}
                </span>
              </div>
              <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <div
                  className={cn('h-full rounded-full', budget.exceeded ? 'bg-destructive' : budget.warn ? 'bg-amber-500' : 'bg-primary')}
                  style={{ width: `${pct}%` }}
                />
              </div>
              {budget.exceeded ? <p className="mt-1.5 text-xs text-destructive">{t('budgetExceededHint')}</p> : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t('budgetNone', { used: formatCompactNumber(budget.used) })}
            </p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="ai-budget" className="text-xs">
                {t('budgetLabel')}
              </Label>
              <Input
                id="ai-budget"
                inputMode="numeric"
                value={budgetInput}
                onChange={(e) => setBudgetInput(e.target.value.replace(/[^\d]/g, ''))}
                placeholder={t('budgetPlaceholder')}
                disabled={!def.configured}
                className="w-48"
              />
            </div>
            <Button size="sm" onClick={() => void saveBudget()} disabled={savingBudget || !def.configured}>
              {savingBudget ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {t('save')}
            </Button>
            {budget.budget ? (
              <Button size="sm" variant="ghost" onClick={() => void saveBudget(true)} disabled={savingBudget}>
                {t('budgetRemove')}
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {/* Connections */}
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">{t('title')}</CardTitle>
              <CardDescription>{t('description')}</CardDescription>
            </div>
            <Button size="sm" onClick={() => setDialog({ key: Date.now(), edit: null })} disabled={!def.configured} title={!def.configured ? t('addNeedsDefault') : undefined}>
              <Plus className="mr-1.5 h-4 w-4" /> {t('add')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border rounded-lg border border-border">
            <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {t('defaultName')}{' '}
                  <span className="ml-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-medium text-primary">{t('defaultBadge')}</span>
                </p>
                {def.configured ? (
                  <p className="text-xs text-muted-foreground">
                    {serviceLabel(def.provider, def.base_url)} · {def.model}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('defaultMissing')}</p>
                )}
                {def.configured ? (
                  <div className="mt-1">
                    <HealthBadge status={def.health_status ?? 'untested'} checkedAt={def.health_checked_at ?? null} error={def.health_error ?? null} />
                  </div>
                ) : null}
              </div>
              <div className="flex gap-2">
                {def.configured ? (
                  <Button size="sm" variant="outline" onClick={() => void test('default')} disabled={testing !== null}>
                    {testing === 'default' ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    {t('test')}
                  </Button>
                ) : null}
                <Button size="sm" variant="ghost" onClick={onGoToSetup}>
                  {def.configured ? t('editInSetup') : t('setUp')}
                </Button>
              </div>
            </li>
            {data.connections.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-foreground">{c.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {serviceLabel(c.provider, c.base_url)} · {c.model}
                  </p>
                  <div className="mt-1">
                    <HealthBadge status={c.health_status} checkedAt={c.health_checked_at} error={c.health_error} />
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="outline" onClick={() => void test(c.id)} disabled={testing !== null}>
                    {testing === c.id ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    {t('test')}
                  </Button>
                  <button
                    type="button"
                    onClick={() => setDialog({ key: Date.now(), edit: c })}
                    className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                    aria-label={t('edit')}
                    title={t('edit')}
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => void remove(c)}
                    className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-destructive"
                    aria-label={t('delete')}
                    title={t('delete')}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Routing */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('routingTitle')}</CardTitle>
          <CardDescription>{t('routingDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!def.configured ? <p className="text-sm text-muted-foreground">{t('routingNeedsDefault')}</p> : null}
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-muted text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">{t('colJob')}</th>
                  <th className="px-3 py-2 font-medium">{t('colConnection')}</th>
                  <th className="px-3 py-2 font-medium">{t('colModel')}</th>
                  <th className="px-3 py-2 font-medium">{t('colOn')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {AI_TASKS.map((task) => {
                  const r = routing.find((x) => x.task === task);
                  if (!r) return null;
                  return (
                    <tr key={task} className="align-top">
                      <td className="max-w-[18rem] px-3 py-2.5">
                        <p className="font-medium text-foreground">{t(`tasks.${task}.name`)}</p>
                        <p className="text-xs text-muted-foreground">{t(`tasks.${task}.desc`)}</p>
                      </td>
                      <td className="px-3 py-2.5">
                        <select
                          className={selectClass}
                          value={r.connectionId ?? ''}
                          onChange={(e) => patchRouting(task, { connectionId: e.target.value || null })}
                          disabled={!def.configured}
                          aria-label={`${t(`tasks.${task}.name`)}: ${t('colConnection')}`}
                        >
                          <option value="">{t('defaultName')}</option>
                          {data.connections.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2.5">
                        <Input
                          value={r.modelOverride ?? ''}
                          onChange={(e) => patchRouting(task, { modelOverride: e.target.value || null })}
                          placeholder={t('modelSameAsConnection')}
                          disabled={!def.configured}
                          aria-label={`${t(`tasks.${task}.name`)}: ${t('colModel')}`}
                          className="h-9"
                        />
                      </td>
                      <td className="px-3 py-2.5">
                        <Switch
                          checked={r.enabled}
                          onCheckedChange={(v) => patchRouting(task, { enabled: v })}
                          disabled={!def.configured}
                          aria-label={`${t(`tasks.${task}.name`)}: ${t('colOn')}`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => void saveRouting()} disabled={!routingDirty || savingRouting || !def.configured}>
              {savingRouting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {t('saveRouting')}
            </Button>
            <p className="text-xs text-muted-foreground">{t('routingHint')}</p>
          </div>
        </CardContent>
      </Card>

      {dialog && (
        <ConnectionDialog
          key={dialog.key}
          edit={dialog.edit}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

function ConnectionDialog({
  edit,
  onClose,
  onSaved,
}: {
  edit: ConnectionRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations('Agents.connections');
  const initial = edit ? selectionFromConfig(edit.provider, edit.base_url) : { preset: 'kimi' as AiPresetId, region: 'global' as KimiRegion, customUrl: '' };

  const [name, setName] = useState(edit?.name ?? '');
  const [preset, setPreset] = useState<AiPresetId>(initial.preset);
  const [region, setRegion] = useState<KimiRegion>(initial.region);
  const [customUrl, setCustomUrl] = useState(initial.customUrl);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(edit?.model ?? '');
  const [models, setModels] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<'save' | 'models' | null>(null);

  const target = resolveSelection({ preset, region, customUrl });
  const compatible = target.provider === 'openai_compatible';

  function pickPreset(p: AiPresetId) {
    setPreset(p);
    const provider = resolveSelection({ preset: p, region, customUrl }).provider;
    // Offer the provider's usual model when the field is untouched.
    if (!edit && (!model || model === AI_PROVIDER_DEFAULT_MODEL.openai || model === AI_PROVIDER_DEFAULT_MODEL.anthropic)) {
      setModel(AI_PROVIDER_DEFAULT_MODEL[provider]);
    }
    setModels([]);
  }

  async function fetchModels() {
    if (!apiKey.trim()) {
      toast.error(t('keyFirst'));
      return;
    }
    setBusy('models');
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: target.provider, base_url: target.baseUrl, api_key: apiKey.trim() }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? t('modelsFailed'));
        return;
      }
      setModels(json.models ?? []);
      if ((json.models ?? []).length === 0) toast.message(t('noModels'));
    } catch {
      toast.error(t('modelsFailed'));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    setBusy('save');
    try {
      const res = await fetch(edit ? `/api/ai/connections/${edit.id}` : '/api/ai/connections', {
        method: edit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          edit
            ? { name: name.trim(), model: model.trim(), ...(apiKey.trim() ? { api_key: apiKey.trim() } : {}) }
            : {
                name: name.trim(),
                provider: target.provider,
                base_url: target.baseUrl,
                model: model.trim(),
                api_key: apiKey.trim(),
                data_notice_ack: compatible ? ack : undefined,
              },
        ),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(json.error ?? t('saveFailed'));
        return;
      }
      toast.success(edit ? t('updated') : t('added'));
      onSaved();
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(null);
    }
  }

  const canSave =
    name.trim().length > 0 &&
    model.trim().length > 0 &&
    (edit ? true : apiKey.trim().length > 0 && (!compatible || ack) && (preset !== 'custom' || customUrl.trim().length > 0)) &&
    busy === null;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{edit ? t('editTitle') : t('addTitle')}</DialogTitle>
          <DialogDescription>{edit ? t('editDescription') : t('addDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="conn-name">{t('nameLabel')}</Label>
            <Input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder={t('namePlaceholder')} />
          </div>

          {edit ? (
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              {t('fixedService', { service: serviceLabel(edit.provider, edit.base_url) })}
            </p>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="conn-preset">{t('serviceLabel')}</Label>
                <select id="conn-preset" className={selectClass} value={preset} onChange={(e) => pickPreset(e.target.value as AiPresetId)}>
                  {AI_PRESET_IDS.map((p) => (
                    <option key={p} value={p}>
                      {PRESET_LABEL[p]}
                    </option>
                  ))}
                </select>
              </div>
              {preset === 'kimi' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="conn-region">{t('regionLabel')}</Label>
                  <select id="conn-region" className={selectClass} value={region} onChange={(e) => setRegion(e.target.value as KimiRegion)}>
                    <option value="global">{t('regionGlobal')}</option>
                    <option value="cn">{t('regionCn')}</option>
                  </select>
                </div>
              ) : null}
              {preset === 'custom' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="conn-url">{t('urlLabel')}</Label>
                  <Input id="conn-url" value={customUrl} onChange={(e) => setCustomUrl(e.target.value)} placeholder="https://api.example.com/v1" />
                </div>
              ) : null}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="conn-key">{edit ? t('newKeyLabel') : t('keyLabel')}</Label>
            <Input
              id="conn-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={edit ? t('keepKey') : PRESET_KEY_PLACEHOLDER[preset]}
              autoComplete="off"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="conn-model">{t('modelLabel')}</Label>
              {!edit ? (
                <button type="button" onClick={() => void fetchModels()} disabled={busy !== null} className="text-xs font-medium text-primary hover:underline disabled:opacity-50">
                  {busy === 'models' ? t('loadingModels') : t('fetchModels')}
                </button>
              ) : null}
            </div>
            <Input id="conn-model" value={model} onChange={(e) => setModel(e.target.value)} list="conn-models" placeholder={t('modelPlaceholder')} />
            <datalist id="conn-models">
              {models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>

          {!edit && compatible ? (
            <label className="flex items-start gap-2 rounded-lg border border-border p-3 text-sm">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-0.5" />
              <span>
                <span className="block font-medium text-foreground">{t('noticeTitle')}</span>
                <span className="block text-xs text-muted-foreground">{t('noticeText', { host: hostOf(target.baseUrl) || t('noticeHostFallback') })}</span>
              </span>
            </label>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={!canSave}>
            {busy === 'save' ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {t('saveAndTest')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
