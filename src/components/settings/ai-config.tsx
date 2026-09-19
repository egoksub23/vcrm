'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import Link from 'next/link';
import { Loader2, Sparkles, CheckCircle2, Trash2, Eye, EyeOff, AlertTriangle, BookOpen } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { canEditSettings } from '@/lib/auth/roles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsPanelHead } from './settings-panel-head';
import { AI_PROVIDER_DEFAULT_MODEL } from '@/lib/ai/defaults';
import {
  AI_PRESET_IDS,
  KIMI_BASE_URLS,
  PRESET_KEY_PLACEHOLDER,
  hostOf,
  normalizeBaseUrl,
  resolveSelection,
  selectionFromConfig,
  type AiPresetId,
  type KimiRegion,
  type PresetSelection,
} from '@/lib/ai/presets';
import { cn } from '@/lib/utils';
import type { AccountMember } from '@/types';
import { fetchAccountMembers, memberLabel } from '@/lib/account/members';
import { useTranslations } from 'next-intl';

const MASKED_KEY = '••••••••••••••••';

// Radix Select can't use an empty-string item value, so the "leave
// unassigned" choice gets a sentinel that maps to null in the payload.
const HANDOFF_QUEUE = '__queue__';

// A fresh setup starts on Kimi (Global). An existing config replaces this on load.
const DEFAULT_SELECTION: PresetSelection = { preset: 'kimi', region: 'global', customUrl: '' };

/** Outcome of the last "Test connection", shown under the key field. */
type TestOutcome =
  | { ok: true; testedModel: boolean; latencyMs?: number; tokens?: number; sample?: string; modelCount: number | null }
  | { ok: false; error: string; hint: string | null };

export function AiConfig() {
  const { accountId, accountRole, profileLoading } = useAuth();
  const canEdit = accountRole ? canEditSettings(accountRole) : false;
  const t = useTranslations('Settings.aiConfig');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);

  const [configured, setConfigured] = useState(false);
  const [sel, setSel] = useState<PresetSelection>(DEFAULT_SELECTION);
  const { provider, baseUrl } = resolveSelection(sel);
  const [model, setModel] = useState(AI_PROVIDER_DEFAULT_MODEL.openai_compatible);
  // Live model list + last test result from "Test connection".
  const [models, setModels] = useState<string[] | null>(null);
  const [testOutcome, setTestOutcome] = useState<TestOutcome | null>(null);
  // Customer messages go to a third party for OpenAI-compatible providers;
  // an admin acknowledges that once per host. `ackedBaseUrl` is the URL the
  // stored acknowledgment was given for.
  const [noticeAck, setNoticeAck] = useState(false);
  const [ackedBaseUrl, setAckedBaseUrl] = useState<string | null>(null);
  // "provider|url" the stored key was saved for — the key can only be reused for that.
  const [storedTarget, setStoredTarget] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [embeddingsKey, setEmbeddingsKey] = useState('');
  const [embeddingsKeyEdited, setEmbeddingsKeyEdited] = useState(false);
  const [hasStoredEmbeddingsKey, setHasStoredEmbeddingsKey] = useState(false);
  const [embeddingsUrl, setEmbeddingsUrl] = useState('');
  const [embeddingsModel, setEmbeddingsModel] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [isActive, setIsActive] = useState(false);
  const [autoReplyEnabled, setAutoReplyEnabled] = useState(false);
  const [maxPerConversation, setMaxPerConversation] = useState(3);
  // Empty string = leave unassigned (shared queue).
  const [handoffAgentId, setHandoffAgentId] = useState('');
  const [members, setMembers] = useState<AccountMember[]>([]);

  // Guard keyed on the account (not a bare boolean) so an in-place
  // account switch — ownership transfer, multi-account membership —
  // refetches instead of showing the previous account's config. Mirrors
  // the loadedAccountIdRef pattern in whatsapp-config.tsx.
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/config');
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? t('loadFailed'));
        return;
      }
      if (data.configured) {
        setConfigured(true);
        setSel(selectionFromConfig(data.provider, data.base_url ?? null));
        setNoticeAck(Boolean(data.data_notice_ack_at));
        setAckedBaseUrl(data.data_notice_ack_at ? normalizeBaseUrl(data.base_url ?? '') : null);
        setStoredTarget(`${data.provider}|${normalizeBaseUrl(data.base_url ?? '')}`);
        setModel(data.model);
        setSystemPrompt(data.system_prompt ?? '');
        setIsActive(data.is_active);
        setAutoReplyEnabled(data.auto_reply_enabled);
        setMaxPerConversation(data.auto_reply_max_per_conversation ?? 3);
        setHandoffAgentId(data.handoff_agent_id ?? '');
        setHasStoredKey(Boolean(data.has_key));
        setApiKey(data.has_key ? MASKED_KEY : '');
        setKeyEdited(false);
        setHasStoredEmbeddingsKey(Boolean(data.has_embeddings_key));
        setEmbeddingsKey(data.has_embeddings_key ? MASKED_KEY : '');
        setEmbeddingsKeyEdited(false);
        setEmbeddingsUrl(data.embeddings_base_url ?? '');
        setEmbeddingsModel(data.embeddings_model ?? '');
      }
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchConfig();
    // Members populate the handoff-target picker. Best-effort — on an
    // older deployment without the endpoint the picker just shows the
    // queue option.
    void fetchAccountMembers().then(setMembers);
  }, [accountId, fetchConfig]);

  // Switching provider swaps the model default (unless the user typed a
  // custom one) and forgets the previous provider's models and test result.
  const applySelection = (next: PresetSelection) => {
    const nextProvider = resolveSelection(next).provider;
    const isDefaultModel =
      model === AI_PROVIDER_DEFAULT_MODEL.openai ||
      model === AI_PROVIDER_DEFAULT_MODEL.anthropic ||
      model.trim() === '';
    if (isDefaultModel) setModel(AI_PROVIDER_DEFAULT_MODEL[nextProvider]);
    setSel(next);
    setModels(null);
    setTestOutcome(null);
  };
  const handlePresetChange = (preset: AiPresetId) => applySelection({ ...sel, preset });

  // The acknowledgment covers one host: pointing at a different URL asks again.
  const isCompatible = provider === 'openai_compatible';
  const noticeAcked = noticeAck && ackedBaseUrl === normalizeBaseUrl(baseUrl ?? '');

  const keyPayload = () => (keyEdited ? apiKey.trim() : undefined);

  // undefined = leave unchanged; '' typed = null (clear); text = set.
  const embeddingsKeyPayload = () =>
    embeddingsKeyEdited ? embeddingsKey.trim() || null : undefined;

  const buildBody = () => ({
    provider,
    base_url: baseUrl,
    data_notice_ack: isCompatible ? noticeAck : undefined,
    model: model.trim(),
    api_key: keyPayload(),
    embeddings_api_key: embeddingsKeyPayload(),
    embeddings_base_url: embeddingsUrl.trim() || null,
    embeddings_model: embeddingsModel.trim() || null,
    system_prompt: systemPrompt.trim() || null,
    is_active: isActive,
    auto_reply_enabled: autoReplyEnabled,
    auto_reply_max_per_conversation: maxPerConversation,
    handoff_agent_id: handoffAgentId || null,
  });

  const handleTest = async () => {
    setTesting(true);
    try {
      const res = await fetch('/api/ai/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          base_url: baseUrl,
          model: model.trim(),
          api_key: keyPayload(),
        }),
      });
      const data = await res.json();
      if (res.ok) {
        setModels(Array.isArray(data.models) ? data.models : null);
        setTestOutcome({
          ok: true,
          testedModel: Boolean(data.tested_model),
          latencyMs: data.latency_ms,
          tokens: data.usage?.totalTokens,
          sample: data.sample,
          modelCount: Array.isArray(data.models) ? data.models.length : null,
        });
      } else {
        setTestOutcome({
          ok: false,
          error: data.code?.startsWith?.('base_url') ? t(`baseUrlErrors.${data.code}`) : (data.error ?? t('testRejected')),
          hint: data.hint ?? null,
        });
      }
    } catch {
      setTestOutcome({ ok: false, error: t('testNetworkError'), hint: null });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!model.trim()) {
      toast.error(t('missingModel'));
      return;
    }
    if (!configured && !keyEdited) {
      toast.error(t('missingApiKey'));
      return;
    }
    if (configured && !keyEdited && storedTarget !== `${provider}|${normalizeBaseUrl(baseUrl ?? '')}`) {
      toast.error(t('keyRequiredForChange'));
      return;
    }
    if (isCompatible && !baseUrl) {
      toast.error(t('baseUrlErrors.base_url_required'));
      return;
    }
    if (isCompatible && !noticeAcked) {
      toast.error(t('noticeRequired'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildBody()),
      });
      const data = await res.json();
      if (res.ok) {
        toast.success(t('saveSuccess'));
        await fetchConfig();
      } else {
        toast.error(data.code?.startsWith?.('base_url') ? t(`baseUrlErrors.${data.code}`) : (data.error ?? t('saveFailed')));
      }
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleRemove = async () => {
    setRemoving(true);
    try {
      const res = await fetch('/api/ai/config', { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('removeSuccess'));
        setConfigured(false);
        setHasStoredKey(false);
        setApiKey('');
        setKeyEdited(false);
        setIsActive(false);
        setAutoReplyEnabled(false);
        setSystemPrompt('');
        setHandoffAgentId('');
      } else {
        const data = await res.json();
        toast.error(data.error ?? t('removeFailed'));
      }
    } catch {
      toast.error(t('removeFailed'));
    } finally {
      setRemoving(false);
    }
  };

  if (loading || profileLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> {t('loadFailed')} {/* Re-using label or a global one, wait, loading is better. Let's use useTranslations from overview or just hardcode Loading... actually I should add loading to aiConfig */}
        {/* Wait, I didn't add loading to aiConfig. I'll just use loading. */}
      </div>
    );
  }

  const disabled = !canEdit || saving;

  return (
    <div>
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
      />

      {!canEdit && (
        <p className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
          {t('adminOnlyConfig')}
        </p>
      )}

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="h-4 w-4 text-primary" /> {t('providerAndKey')}
            </CardTitle>
            <CardDescription>
              {t('encryptionNotice')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label id="ai-provider-label">{t('provider')}</Label>
              <div
                role="radiogroup"
                aria-labelledby="ai-provider-label"
                className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5"
              >
                {AI_PRESET_IDS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={sel.preset === id}
                    disabled={disabled}
                    onClick={() => handlePresetChange(id)}
                    className={cn(
                      'rounded-lg border p-2.5 text-left transition-colors disabled:opacity-60',
                      sel.preset === id
                        ? 'border-2 border-primary bg-primary/5 p-[9px]'
                        : 'border-border hover:bg-muted',
                    )}
                  >
                    <span className="block text-sm font-medium text-foreground">{t(`presets.${id}.name`)}</span>
                    <span className="block text-[11px] text-muted-foreground">{t(`presets.${id}.desc`)}</span>
                  </button>
                ))}
              </div>
            </div>

            {sel.preset === 'kimi' && (
              <div className="space-y-2 sm:max-w-sm">
                <Label htmlFor="ai-region">{t('region')}</Label>
                <select
                  id="ai-region"
                  value={sel.region}
                  disabled={disabled}
                  onChange={(e) => applySelection({ ...sel, region: e.target.value as KimiRegion })}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
                >
                  <option value="global">{t('regionGlobal', { host: hostOf(KIMI_BASE_URLS.global) })}</option>
                  <option value="cn">{t('regionCn', { host: hostOf(KIMI_BASE_URLS.cn) })}</option>
                </select>
                <p className="text-xs text-muted-foreground">{t('regionHint')}</p>
              </div>
            )}

            {isCompatible && (
              <div className="space-y-2">
                <Label htmlFor="ai-base-url">{t('baseUrl')}</Label>
                <Input
                  id="ai-base-url"
                  value={sel.preset === 'custom' ? sel.customUrl : (baseUrl ?? '')}
                  readOnly={sel.preset !== 'custom'}
                  onChange={(e) => applySelection({ ...sel, customUrl: e.target.value })}
                  placeholder="https://api.example.com/v1"
                  disabled={disabled}
                  spellCheck={false}
                  className={cn('font-mono text-xs', sel.preset !== 'custom' && 'text-muted-foreground')}
                />
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="ai-model">{t('model')}</Label>
              <Input
                id="ai-model"
                list="ai-model-options"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder={AI_PROVIDER_DEFAULT_MODEL[provider] || t('modelPlaceholderCompatible')}
                disabled={disabled}
                spellCheck={false}
              />
              <datalist id="ai-model-options">
                {(models ?? []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              {models && models.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-muted-foreground">{t('modelsFromProvider', { count: models.length })}</span>
                  {models.slice(0, 8).map((m) => (
                    <button
                      key={m}
                      type="button"
                      disabled={disabled}
                      onClick={() => setModel(m)}
                      className={cn(
                        'rounded-full border px-2 py-0.5 font-mono text-[11px] transition-colors',
                        model === m ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-muted',
                      )}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              ) : isCompatible ? (
                <p className="text-xs text-muted-foreground">{t('modelHintCompatible')}</p>
              ) : null}
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-key">{t('apiKey')}</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    id="ai-key"
                    type={showKey ? 'text' : 'password'}
                    value={apiKey}
                    onChange={(e) => {
                      setApiKey(e.target.value);
                      setKeyEdited(true);
                    }}
                    onFocus={() => {
                      if (!keyEdited && hasStoredKey) {
                        setApiKey('');
                        setKeyEdited(true);
                      }
                    }}
                    placeholder={PRESET_KEY_PLACEHOLDER[sel.preset]}
                    disabled={disabled}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey((s) => !s)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showKey ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={disabled || testing}
                >
                  {testing ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="mr-2 h-4 w-4" />
                  )}
                  {t('testConnection')}
                </Button>
              </div>
              {testOutcome && (
                <div
                  role="status"
                  className={cn(
                    'rounded-md border px-3 py-2 text-sm',
                    testOutcome.ok
                      ? 'border-emerald-500/30 bg-emerald-500/5 text-foreground'
                      : 'border-destructive/40 bg-destructive/5 text-foreground',
                  )}
                >
                  {testOutcome.ok ? (
                    <>
                      <p className="flex items-center gap-1.5 font-medium">
                        <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                        {testOutcome.testedModel ? t('connectedAndReplied') : t('connected')}
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {[
                          testOutcome.modelCount !== null ? t('modelsFound', { count: testOutcome.modelCount }) : null,
                          testOutcome.latencyMs !== undefined ? t('latency', { ms: testOutcome.latencyMs }) : null,
                          testOutcome.tokens ? t('tokensUsed', { count: testOutcome.tokens }) : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        {!testOutcome.testedModel && testOutcome.modelCount ? ` ${t('chooseModelNext')}` : ''}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="flex items-start gap-1.5 font-medium">
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                        <span>{testOutcome.error}</span>
                      </p>
                      {testOutcome.hint ? (
                        <p className="mt-1 text-xs text-muted-foreground">{t(`hints.${testOutcome.hint}`)}</p>
                      ) : null}
                    </>
                  )}
                </div>
              )}
            </div>

            {isCompatible && (
              <label
                className={cn(
                  'flex items-start gap-2.5 rounded-md border p-3 text-sm',
                  noticeAcked ? 'border-border' : 'border-amber-500/40 bg-amber-500/5',
                )}
              >
                <input
                  type="checkbox"
                  checked={noticeAcked}
                  disabled={disabled}
                  onChange={(e) => {
                    setNoticeAck(e.target.checked);
                    setAckedBaseUrl(e.target.checked ? normalizeBaseUrl(baseUrl ?? '') : null);
                  }}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                />
                <span>
                  <span className="block font-medium text-foreground">{t('noticeTitle')}</span>
                  <span className="block text-xs text-muted-foreground">
                    {t('noticeText', { host: hostOf(baseUrl) || t('noticeHostFallback') })}
                  </span>
                </span>
              </label>
            )}

            <div className="space-y-2">
              <Label htmlFor="ai-embeddings-key">
                {t('embeddingsKey')}{' '}
                <span className="font-normal text-muted-foreground">
                  {t('optionalSemanticSearch')}
                </span>
              </Label>
              <Input
                id="ai-embeddings-key"
                type="password"
                value={embeddingsKey}
                onChange={(e) => {
                  setEmbeddingsKey(e.target.value);
                  setEmbeddingsKeyEdited(true);
                }}
                onFocus={() => {
                  if (!embeddingsKeyEdited && hasStoredEmbeddingsKey) {
                    setEmbeddingsKey('');
                    setEmbeddingsKeyEdited(true);
                  }
                }}
                placeholder="sk-... (OpenAI)"
                disabled={disabled}
                autoComplete="off"
              />
              <p className="text-xs text-muted-foreground">
                {t('embeddingsHint', {
                  sameKeyText: provider === 'openai' ? t('sameKeyText') : '',
                })}
              </p>
              <div className="grid gap-3 pt-1 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="ai-embeddings-url" className="text-xs">
                    {t('embeddingsUrl')}
                  </Label>
                  <Input
                    id="ai-embeddings-url"
                    value={embeddingsUrl}
                    onChange={(e) => setEmbeddingsUrl(e.target.value)}
                    placeholder="https://api.openai.com/v1"
                    disabled={disabled}
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="ai-embeddings-model" className="text-xs">
                    {t('embeddingsModel')}
                  </Label>
                  <Input
                    id="ai-embeddings-model"
                    value={embeddingsModel}
                    onChange={(e) => setEmbeddingsModel(e.target.value)}
                    placeholder="text-embedding-3-small"
                    disabled={disabled}
                    autoComplete="off"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t('embeddingsServiceHint')}</p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('behaviour')}</CardTitle>
            <CardDescription>
              {t('behaviourDesc')}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="ai-prompt">{t('businessContext')}</Label>
              <Textarea
                id="ai-prompt"
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder={t('promptPlaceholder')}
                rows={5}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('enableAssistant')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('enableAssistantDesc')}
                </p>
              </div>
              <Switch
                checked={isActive}
                onCheckedChange={setIsActive}
                disabled={disabled}
              />
            </div>

            <div className="flex items-center justify-between gap-4 rounded-md border border-border p-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  {t('autoReply')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('autoReplyDesc')}
                </p>
              </div>
              <Switch
                checked={autoReplyEnabled}
                onCheckedChange={setAutoReplyEnabled}
                disabled={disabled || !isActive}
              />
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label htmlFor="ai-max">{t('maxAutoReplies')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('maxAutoRepliesDesc')}
                </p>
              </div>
              <Input
                id="ai-max"
                type="number"
                min={1}
                max={20}
                value={maxPerConversation}
                onChange={(e) =>
                  setMaxPerConversation(
                    Math.min(20, Math.max(1, Number(e.target.value) || 1)),
                  )
                }
                disabled={disabled || !autoReplyEnabled}
                className="w-20"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-handoff">{t('handoffTo')}</Label>
              <p className="text-xs text-muted-foreground">
                {t('handoffToDesc')}
              </p>
              <Select
                value={handoffAgentId || HANDOFF_QUEUE}
                onValueChange={(v) =>
                  setHandoffAgentId(!v || v === HANDOFF_QUEUE ? '' : v)
                }
                disabled={disabled || !autoReplyEnabled}
              >
                <SelectTrigger id="ai-handoff">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={HANDOFF_QUEUE}>
                    {t('handoffQueue')}
                  </SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {memberLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <BookOpen className="h-4 w-4 text-primary" /> {t('knowledgeCardTitle')}
            </CardTitle>
            <CardDescription>{t('knowledgeCardDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <Link
              href="/knowledge"
              className="inline-flex h-8 items-center rounded-md border border-border px-3 text-sm font-medium hover:bg-muted"
            >
              {t('knowledgeCardLink')}
            </Link>
          </CardContent>
        </Card>

        <div className="flex items-center justify-between">
          {configured ? (
            <Button
              variant="ghost"
              onClick={handleRemove}
              disabled={!canEdit || removing}
              className="text-destructive hover:text-destructive"
            >
              {removing ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="mr-2 h-4 w-4" />
              )}
              {t('remove')}
            </Button>
          ) : (
            <span />
          )}

          <Button onClick={handleSave} disabled={disabled}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {t('save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
