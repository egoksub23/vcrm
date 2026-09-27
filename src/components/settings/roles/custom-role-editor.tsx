'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Copy, Loader2, Trash2 } from 'lucide-react';

import type { CustomRoleEntry } from '@/app/api/account/roles/custom/route';
import type { RoleMatrixEntry } from '@/app/api/account/roles/route';
import { Button } from '@/components/ui/button';
import { ROLE_META } from '../role-meta';
import { SettingsChip } from '../settings-chip';
import { CapabilityList } from './capability-list';
import { ConfirmDialog } from './confirm-dialog';
import {
  buildChangeSummary,
  buildChangesPayload,
  countChanges,
  countDifferingFromDefault,
  draftSet,
  editsFromDesired,
  savedSet,
  setEdit,
  type DraftEdits,
} from './helpers';
import { SaveBar } from './save-bar';
import { DEFAULT_CAPABILITIES } from '@/lib/auth/capabilities';

interface CustomRoleEditorProps {
  entry: CustomRoleEntry;
  editorRole: RoleMatrixEntry['role'];
  editorCaps: ReadonlySet<string>;
  onChanged: () => Promise<boolean>;
  onDeleted: () => void;
  onDuplicate: (source: CustomRoleEntry) => void;
}

/** The capability editor for one custom role — same edit/save/confirm
 *  machinery as the built-in RolesEditor (./roles/helpers.ts is fully
 *  role-agnostic: every function only ever needs the role's RANK and
 *  DEFAULT set, both of which a custom role gets from its `baseRole`),
 *  plus a header offering Duplicate/Delete instead of presets. */
export function CustomRoleEditor({
  entry,
  editorRole,
  editorCaps,
  onChanged,
  onDeleted,
  onDuplicate,
}: CustomRoleEditorProps) {
  const t = useTranslations('Permissions');
  const tc = useTranslations('Permissions.customRoles');
  const tRoles = useTranslations('Settings.roles');
  const meta = ROLE_META[entry.baseRole];
  const Icon = meta.icon;

  const saved = useMemo(() => savedSet(entry.effective), [entry.effective]);
  const [edits, setEdits] = useState<DraftEdits>({});
  const draft = useMemo(() => draftSet(saved, edits), [saved, edits]);
  const changeCount = countChanges(saved, edits);

  const [query, setQuery] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function toggle(cap: string, next: boolean) {
    setEdits((prev) => setEdit(saved, prev, cap, next));
  }

  function resetToDefault() {
    const desired = DEFAULT_CAPABILITIES[entry.baseRole];
    setEdits(editsFromDesired(saved, desired));
    toast.success(t('screen.resetApplied'));
  }

  async function save() {
    const changes = buildChangesPayload(entry.baseRole, saved, draft);
    if (Object.keys(changes).length === 0) {
      setConfirmOpen(false);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/account/roles/custom/${entry.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveError(payload.error || t('errors.saveFailed'));
        return;
      }
      toast.success(t('screen.savedToast', { role: entry.name }));
      setConfirmOpen(false);
      const refreshed = await onChanged();
      if (refreshed) setEdits({});
      else toast.warning(t('errors.refreshAfterSave'));
    } catch (err) {
      console.error('[CustomRoleEditor] save error:', err);
      setSaveError(t('errors.network'));
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    const message =
      entry.memberCount > 0
        ? tc('deleteConfirmWithMembers', { count: entry.memberCount, name: entry.name })
        : tc('deleteConfirmBody', { name: entry.name });
    if (!window.confirm(message)) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/account/roles/custom/${entry.id}`, { method: 'DELETE' });
      const data = (await res.json().catch(() => ({}))) as { error?: string; demotedMembers?: number };
      if (!res.ok) {
        toast.error(data.error || tc('deleteFailed'));
        return;
      }
      toast.success(
        data.demotedMembers && data.demotedMembers > 0
          ? tc('deletedWithMembers', { count: data.demotedMembers })
          : tc('deleted'),
      );
      onDeleted();
    } catch {
      toast.error(tc('deleteFailed'));
    } finally {
      setDeleting(false);
    }
  }

  const summary = useMemo(() => buildChangeSummary(saved, draft), [saved, draft]);
  // CapabilityList/ConfirmDialog only ever read `role` for rank/default
  // lookups, never to display it — a custom role's baseRole is exactly
  // the right value to pass in its place.
  const asMatrixEntry: RoleMatrixEntry = {
    role: entry.baseRole,
    memberCount: entry.memberCount,
    editable: entry.editable,
    effective: entry.effective,
    overrides: entry.overrides,
    changed: entry.changed,
  };

  return (
    <div className="min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <h3 className="min-w-0 truncate text-sm font-semibold text-foreground">{entry.name}</h3>
          <SettingsChip variant={meta.variant} className={meta.className}>
            {tc('basedOn', { role: tRoles(entry.baseRole) })}
          </SettingsChip>
        </div>
        {entry.editable && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onDuplicate(entry)}>
              <Copy className="mr-1.5 size-3.5" /> {tc('duplicate')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="text-destructive hover:text-destructive"
              onClick={() => void confirmDelete()}
              disabled={deleting}
            >
              {deleting ? <Loader2 className="mr-1.5 size-3.5 animate-spin" /> : <Trash2 className="mr-1.5 size-3.5" />}
              {tc('delete')}
            </Button>
            {countDifferingFromDefault(entry.baseRole, draft) > 0 && (
              <Button variant="ghost" size="sm" onClick={resetToDefault}>
                {t('screen.resetDefault')}
              </Button>
            )}
          </div>
        )}
      </div>

      <CapabilityList
        entry={asMatrixEntry}
        editorRole={editorRole}
        editorCaps={editorCaps}
        saved={saved}
        draft={draft}
        query={query}
        onlyChanged={onlyChanged}
        onQueryChange={setQuery}
        onOnlyChangedChange={setOnlyChanged}
        onToggle={toggle}
      />
      <SaveBar count={changeCount} saving={saving} onSave={() => setConfirmOpen(true)} onDiscard={() => setEdits({})} />

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        role={entry.baseRole}
        roleName={entry.name}
        memberCount={entry.memberCount}
        summary={summary}
        saving={saving}
        error={saveError}
        onConfirm={() => void save()}
      />
    </div>
  );
}
