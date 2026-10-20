'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Layers, Loader2, Lock, Search, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  ADDON_DESCRIPTION_MAX,
  ADDON_NAME_MAX,
  type AddonRoleEntry,
} from '@/lib/auth/addon-roles';
import { CAPABILITIES, capabilityI18nId } from '@/lib/auth/capabilities';
import { SettingsChip } from '../settings-chip';
import {
  addonChangeCount,
  addonSaveBody,
  addonSwitchBlocked,
  savedAddonSet,
  type AddonDraft,
} from './addon-role-helpers';
import { groupCapabilities } from './helpers';
import { SaveBar } from './save-bar';
import { TierChip } from './tier-chip';

/**
 * The editor for ONE add-on role (migration 191): its name and description, and a switch per permission. An add-on only adds, so a switch means "this
 * role gives that permission". A permission can be switched ON only by someone who holds it themselves; switching one OFF is always allowed.
 */
export function AddonRoleEditor({
  entry,
  editorCaps,
  onChanged,
  onDeleted,
}: {
  entry: AddonRoleEntry;
  editorCaps: ReadonlySet<string>;
  onChanged: () => Promise<boolean>;
  onDeleted: () => void;
}) {
  const t = useTranslations('Permissions');
  const ta = useTranslations('Permissions.addons');
  const tRoles = useTranslations('Settings.roles');

  const saved = useMemo<AddonDraft>(
    () => ({ name: entry.name, description: entry.description ?? '', capabilities: savedAddonSet(entry.capabilities) }),
    [entry.name, entry.description, entry.capabilities],
  );
  const [name, setName] = useState(saved.name);
  const [description, setDescription] = useState(saved.description);
  const [caps, setCaps] = useState<ReadonlySet<string>>(saved.capabilities);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const draft: AddonDraft = { name, description, capabilities: caps };
  const changes = addonChangeCount(saved, draft);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = CAPABILITIES.filter((cap) => {
      if (!q) return true;
      const id = capabilityI18nId(cap.key);
      return (
        t(`cap.${id}.label`).toLowerCase().includes(q) ||
        t(`cap.${id}.description`).toLowerCase().includes(q) ||
        cap.key.toLowerCase().includes(q)
      );
    });
    return groupCapabilities(items);
  }, [query, t]);

  function toggle(key: string, next: boolean) {
    setCaps((prev) => {
      const out = new Set(prev);
      if (next) out.add(key);
      else out.delete(key);
      return out;
    });
  }

  function discard() {
    setName(saved.name);
    setDescription(saved.description);
    setCaps(saved.capabilities);
    setError(null);
  }

  async function save() {
    const body = addonSaveBody(saved, draft);
    if (!body) {
      if (name.trim() === '') setError(ta('nameRequired'));
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/account/roles/addons/${entry.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setError(payload.error || ta('saveFailed'));
        return;
      }
      toast.success(ta('saved', { name: name.trim() }));
      const refreshed = await onChanged();
      if (!refreshed) toast.warning(t('errors.refreshAfterSave'));
    } catch (err) {
      console.error('[AddonRoleEditor] save error:', err);
      setError(t('errors.network'));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    const message =
      entry.memberCount > 0
        ? ta('deleteConfirmWithMembers', { count: entry.memberCount, name: entry.name })
        : ta('deleteConfirmBody', { name: entry.name });
    if (!window.confirm(message)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/account/roles/addons/${entry.id}`, { method: 'DELETE' });
      const data = (await res.json().catch(() => ({}))) as { error?: string; members?: number };
      if (!res.ok) {
        toast.error(data.error || ta('deleteFailed'));
        return;
      }
      toast.success(ta('deleted'));
      onDeleted();
    } catch {
      toast.error(ta('deleteFailed'));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Layers className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">{entry.name}</h3>
          <SettingsChip variant="muted">{ta('memberCount', { count: entry.memberCount })}</SettingsChip>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={() => void remove()}
          disabled={deleting || saving}
        >
          {deleting ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Trash2 className="mr-1.5 size-3.5" />}
          {ta('delete')}
        </Button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={`addon-name-${entry.id}`}>{ta('nameLabel')}</Label>
          <Input
            id={`addon-name-${entry.id}`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={ADDON_NAME_MAX}
            disabled={saving}
          />
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor={`addon-desc-${entry.id}`}>{ta('descriptionLabel')}</Label>
          <Textarea
            id={`addon-desc-${entry.id}`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={ta('descriptionPlaceholder')}
            maxLength={ADDON_DESCRIPTION_MAX}
            rows={2}
            disabled={saving}
          />
        </div>
      </div>

      <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs text-muted-foreground" data-testid="addon-only-adds">
        {ta('onlyAdds')}
        {entry.minBaseRole !== 'viewer' ? ` ${ta('appliesFrom', { role: tRoles(entry.minBaseRole) })}` : ''}
      </p>

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('screen.searchPlaceholder')}
          aria-label={t('screen.searchLabel')}
          className="pl-8"
        />
      </div>

      {groups.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{t('screen.noResults')}</p>
      ) : (
        groups.map((block) => (
          <section key={block.group} aria-labelledby={`addon-group-${entry.id}-${block.group}`}>
            <h4
              id={`addon-group-${entry.id}-${block.group}`}
              className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
            >
              {t(`group.${block.group}`)}
            </h4>
            <Card>
              <CardContent className="p-0">
                <ul className="divide-y divide-border">
                  {block.items.map((cap) => {
                    const id = capabilityI18nId(cap.key);
                    const on = caps.has(cap.key);
                    const blocked = addonSwitchBlocked(cap, on, editorCaps);
                    const labelId = `addon-cap-${entry.id}-${id}`;
                    return (
                      <li key={cap.key} className={`flex items-start gap-3 px-4 py-3 ${on !== saved.capabilities.has(cap.key) ? 'bg-primary-soft/40' : ''}`}>
                        <div className="pt-0.5">
                          <Switch
                            checked={on}
                            disabled={blocked !== null || saving}
                            onCheckedChange={(next) => toggle(cap.key, next)}
                            aria-labelledby={labelId}
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span id={labelId} className="text-sm font-medium text-foreground">
                              {t(`cap.${id}.label`)}
                            </span>
                            {cap.minGrantRole !== 'viewer' ? (
                              <SettingsChip variant="muted" className="px-2 py-0 text-[11px]">
                                {ta('needsRole', { role: tRoles(cap.minGrantRole) })}
                              </SettingsChip>
                            ) : null}
                            <TierChip enforcedBy={cap.enforcedBy} />
                          </div>
                          <p className="mt-0.5 text-xs text-muted-foreground">{t(`cap.${id}.description`)}</p>
                          {blocked ? (
                            <p className="mt-1 flex items-start gap-1 text-xs text-muted-foreground">
                              <Lock className="mt-0.5 size-3 shrink-0" aria-hidden />
                              <span>{ta('reasonNotHeld')}</span>
                            </p>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </CardContent>
            </Card>
          </section>
        ))
      )}

      {error ? (
        <p role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <SaveBar count={changes} saving={saving} onSave={() => void save()} onDiscard={discard} />
    </div>
  );
}
