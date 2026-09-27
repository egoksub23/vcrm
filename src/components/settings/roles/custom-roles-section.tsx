'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Plus } from 'lucide-react';

import type { CustomRoleEntry } from '@/app/api/account/roles/custom/route';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { AccountRole } from '@/lib/auth/roles';
import { ROLE_META } from '../role-meta';
import { CustomRoleEditor } from './custom-role-editor';
import { NewCustomRoleDialog } from './new-custom-role-dialog';
import { useCustomRoles } from './use-custom-roles';

interface CustomRolesSectionProps {
  editorRole: AccountRole;
  editorCaps: ReadonlySet<string>;
}

/** Sibling to the 4 built-in roles: an account's own named roles, each
 *  a capability-set profile pinned to one of the three non-owner base
 *  tiers (migration 112-114). Named, creatable from scratch or by
 *  duplicating an existing role (built-in or custom), assignable to
 *  specific members from the invite dialog / member panel. */
export function CustomRolesSection({ editorRole, editorCaps }: CustomRolesSectionProps) {
  const t = useTranslations('Permissions.customRoles');
  const { state, refetch } = useCustomRoles();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [duplicateFrom, setDuplicateFrom] = useState<CustomRoleEntry | null>(null);

  const roles = state.status === 'ready' ? state.data : [];
  // Falls back to the first role when nothing is picked yet, or when a
  // picked role was deleted out from under the selection — no effect
  // needed to keep this in sync.
  const selected = roles.find((r) => r.id === selectedId) ?? roles[0] ?? null;

  function openCreate() {
    setDuplicateFrom(null);
    setDialogOpen(true);
  }

  function openDuplicate(source: CustomRoleEntry) {
    setDuplicateFrom(source);
    setDialogOpen(true);
  }

  async function afterCreate(id: string) {
    await refetch();
    setSelectedId(id);
  }

  async function afterDelete() {
    setSelectedId(null);
    await refetch();
  }

  if (state.status === 'loading') return null;
  if (state.status !== 'ready') return null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('sectionTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('sectionDescription')}</p>
        </div>
        <Button size="sm" onClick={openCreate}>
          <Plus className="mr-1.5 size-4" /> {t('newRole')}
        </Button>
      </div>

      {roles.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          {t('empty')}
        </p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start">
          <nav aria-label={t('sectionTitle')}>
            <ul className="grid gap-0.5">
              {roles.map((r) => {
                const meta = ROLE_META[r.baseRole];
                const Icon = meta.icon;
                const isSelected = r.id === selected?.id;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(r.id)}
                      aria-current={isSelected ? 'true' : undefined}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                        isSelected ? 'bg-primary/15 font-medium text-primary' : 'text-foreground hover:bg-muted',
                      )}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{r.name}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{r.memberCount}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {selected ? (
            <CustomRoleEditor
              key={selected.id}
              entry={selected}
              editorRole={editorRole}
              editorCaps={editorCaps}
              onChanged={refetch}
              onDeleted={() => void afterDelete()}
              onDuplicate={openDuplicate}
            />
          ) : null}
        </div>
      )}

      <NewCustomRoleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editorRole={editorRole}
        customRoles={roles}
        duplicateFrom={duplicateFrom}
        onCreated={(id) => void afterCreate(id)}
      />
    </div>
  );
}
