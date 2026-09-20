'use client';

// ============================================================
// RolesPermissionsTab — Settings → Roles & permissions
//
// Composition root. Owner/Admin edit what each role (owner, admin,
// agent, viewer) can see and do. The screen only mirrors the
// guardrails enforced inside `set_role_capabilities` so nothing looks
// possible that the database would refuse.
//
// State model
//   * The matrix (saved state) comes from GET /api/account/roles.
//   * The draft is kept PER ROLE as sparse edits laid over the saved
//     state, so switching roles never loses edits and a refetch can
//     never resurrect stale values.
//   * Save asks for confirmation, then PUTs only the keys that differ
//     from the saved state.
//
// The pieces live in ./roles/*; pure rules are in ./roles/helpers.ts.
// ============================================================

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import type { RoleMatrixResponse } from '@/app/api/account/roles/route';
import {
  DEFAULT_CAPABILITIES,
  presetCapabilities,
  type CapabilityPreset,
} from '@/lib/auth/capabilities';
import type { AccountRole } from '@/lib/auth/roles';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ByCapabilityView } from './roles/by-capability-view';
import { CapabilityList } from './roles/capability-list';
import { ConfirmDialog } from './roles/confirm-dialog';
import {
  buildChangeSummary,
  buildChangesPayload,
  clampDesired,
  countChanges,
  countDifferingFromDefault,
  draftSet,
  editsFromDesired,
  savedSet,
  setEdit,
  type DraftEdits,
} from './roles/helpers';
import { LogDrawer } from './roles/log-drawer';
import { RoleHeader } from './roles/role-header';
import { RoleList } from './roles/role-list';
import { SaveBar } from './roles/save-bar';
import {
  LoadErrorState,
  NoAccessState,
  RolesSkeleton,
} from './roles/states';
import { useRoleMatrix } from './roles/use-role-matrix';
import { SettingsPanelHead } from './settings-panel-head';

export function RolesPermissionsTab() {
  const t = useTranslations('Permissions');
  const { state, refetch, retry } = useRoleMatrix();

  return (
    <section className="animate-in fade-in-50 space-y-4 duration-200">
      <SettingsPanelHead
        title={t('screen.title')}
        description={t('screen.description')}
        className="mb-1"
      />
      {state.status === 'loading' ? <RolesSkeleton /> : null}
      {state.status === 'forbidden' ? <NoAccessState /> : null}
      {state.status === 'error' ? (
        <LoadErrorState
          message={state.message}
          onRetry={() => void retry()}
        />
      ) : null}
      {state.status === 'ready' && state.data.roles.length > 0 ? (
        <Tabs defaultValue="roles" className="gap-4">
          <TabsList>
            <TabsTrigger value="roles">{t('screen.tabRoles')}</TabsTrigger>
            <TabsTrigger value="capabilities">
              {t('screen.tabCapabilities')}
            </TabsTrigger>
          </TabsList>
          {/* keepMounted: the editor holds the unsaved drafts, which
              must survive a look at the reverse view. */}
          <TabsContent value="roles" keepMounted>
            <RolesEditor data={state.data} refetch={refetch} />
          </TabsContent>
          <TabsContent value="capabilities">
            <ByCapabilityView data={state.data} />
          </TabsContent>
        </Tabs>
      ) : null}
    </section>
  );
}

function RolesEditor({
  data,
  refetch,
}: {
  data: RoleMatrixResponse;
  refetch: () => Promise<boolean>;
}) {
  const t = useTranslations('Permissions');
  const tRoles = useTranslations('Settings.roles');

  const editorCaps = useMemo(
    () => new Set(data.editorCapabilities),
    [data.editorCapabilities],
  );

  // The first role the caller may edit is selected until they pick one.
  const [picked, setPicked] = useState<AccountRole | null>(null);
  const firstEditable =
    data.roles.find((r) => r.editable)?.role ?? data.roles[0].role;
  const entry =
    data.roles.find((r) => r.role === (picked ?? firstEditable)) ??
    data.roles[0];
  const role = entry.role;

  const [drafts, setDrafts] = useState<
    Partial<Record<AccountRole, DraftEdits>>
  >({});
  const [query, setQuery] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const saved = useMemo(() => savedSet(entry.effective), [entry.effective]);
  const edits = drafts[role];
  const draft = useMemo(() => draftSet(saved, edits), [saved, edits]);
  const changeCount = countChanges(saved, edits);

  // Unsaved counts for every role, for the dots in the role list and
  // for the leave-page warning.
  const unsavedByRole = useMemo(() => {
    const out: Partial<Record<AccountRole, number>> = {};
    for (const r of data.roles) {
      out[r.role] = countChanges(savedSet(r.effective), drafts[r.role]);
    }
    return out;
  }, [data.roles, drafts]);
  const anyUnsaved = Object.values(unsavedByRole).some((n) => (n ?? 0) > 0);

  // Warn before a full-page navigation throws away unsaved edits.
  useEffect(() => {
    if (!anyUnsaved) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [anyUnsaved]);

  function setRoleEdits(next: DraftEdits) {
    setDrafts((prev) => ({ ...prev, [role]: next }));
  }

  function toggle(cap: string, next: boolean) {
    setDrafts((prev) => ({
      ...prev,
      [role]: setEdit(saved, prev[role], cap, next),
    }));
  }

  /** Bulk desired sets (preset / reset): clamp what the editor cannot grant. */
  function applyDesired(desired: ReadonlySet<string>): number {
    const clamped = clampDesired({
      editorRole: data.role,
      editorCaps,
      targetRole: role,
      saved,
      desired,
    });
    setRoleEdits(editsFromDesired(saved, clamped.desired));
    return clamped.skipped.length;
  }

  function applyPreset(preset: CapabilityPreset) {
    const skipped = applyDesired(presetCapabilities(role, preset));
    toast.success(
      t('screen.presetApplied', { name: t(`preset.${preset.id}.name`) }),
    );
    if (skipped > 0) toast.warning(t('screen.bulkSkipped', { count: skipped }));
  }

  function resetToDefault() {
    const skipped = applyDesired(DEFAULT_CAPABILITIES[role]);
    toast.success(t('screen.resetApplied'));
    if (skipped > 0) toast.warning(t('screen.bulkSkipped', { count: skipped }));
  }

  function discard() {
    setRoleEdits({});
  }

  function selectRole(next: AccountRole) {
    setPicked(next);
    setSaveError(null);
  }

  function openConfirm() {
    setSaveError(null);
    setConfirmOpen(true);
  }

  async function save() {
    const changes = buildChangesPayload(role, saved, draft);
    if (Object.keys(changes).length === 0) {
      setConfirmOpen(false);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/account/roles/${role}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ changes }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setSaveError(payload.error || t('errors.saveFailed'));
        return;
      }
      toast.success(t('screen.savedToast', { role: tRoles(role) }));
      setConfirmOpen(false);
      const refreshed = await refetch();
      if (refreshed) {
        setRoleEdits({});
      } else {
        // Saved, but the fresh state could not be loaded: keep the
        // draft (it re-baselines against whatever loads next).
        toast.warning(t('errors.refreshAfterSave'));
      }
    } catch (err) {
      console.error('[RolesPermissionsTab] save error:', err);
      setSaveError(t('errors.network'));
    } finally {
      setSaving(false);
    }
  }

  const summary = useMemo(
    () => buildChangeSummary(saved, draft),
    [saved, draft],
  );

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start">
      <RoleList
        roles={data.roles}
        selected={role}
        unsaved={unsavedByRole}
        onSelect={selectRole}
      />

      <div className="min-w-0 space-y-4">
        <RoleHeader
          entry={entry}
          atDefault={countDifferingFromDefault(role, draft) === 0}
          onApplyPreset={applyPreset}
          onReset={resetToDefault}
          onOpenLog={() => setLogOpen(true)}
        />
        <CapabilityList
          entry={entry}
          editorRole={data.role}
          editorCaps={editorCaps}
          saved={saved}
          draft={draft}
          query={query}
          onlyChanged={onlyChanged}
          onQueryChange={setQuery}
          onOnlyChangedChange={setOnlyChanged}
          onToggle={toggle}
        />
        <SaveBar
          count={changeCount}
          saving={saving}
          onSave={openConfirm}
          onDiscard={discard}
        />
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        role={role}
        memberCount={entry.memberCount}
        summary={summary}
        saving={saving}
        error={saveError}
        onConfirm={() => void save()}
      />
      <LogDrawer open={logOpen} onOpenChange={setLogOpen} role={role} />
    </div>
  );
}
