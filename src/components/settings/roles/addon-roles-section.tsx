'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Layers, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { AddonRoleEditor } from './addon-role-editor';
import { NewAddonRoleDialog } from './new-addon-role-dialog';
import { useAddonRoles } from './use-addon-roles';

/**
 * Add-on roles (migration 191): named sets of extra permissions a person is given ON TOP of their base role. They only add. Listed on the left, the
 * selected one edited on the right, like the custom roles beside it. Given to a person from the member panel, or carried by an invitation.
 */
export function AddonRolesSection({ editorCaps }: { editorCaps: ReadonlySet<string> }) {
  const t = useTranslations('Permissions.addons');
  const { state, refetch } = useAddonRoles();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  if (state.status === 'loading') return null;
  if (state.status === 'error') {
    return (
      <div className="space-y-2" role="alert">
        <p className="text-sm text-destructive">{state.message || t('loadFailed')}</p>
        <Button variant="outline" size="sm" onClick={() => void refetch()}>
          {t('retry')}
        </Button>
      </div>
    );
  }

  const roles = state.data;
  // Falls back to the first role when nothing is picked, or when the picked one was deleted.
  const selected = roles.find((r) => r.id === selectedId) ?? roles[0] ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{t('sectionTitle')}</h3>
          <p className="text-xs text-muted-foreground">{t('sectionDescription')}</p>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="mr-1.5 size-4" /> {t('newRole')}
        </Button>
      </div>

      {roles.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)] lg:items-start">
          <nav aria-label={t('sectionTitle')}>
            <ul className="grid gap-0.5">
              {roles.map((r) => {
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
                      <Layers className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1 truncate">{r.name}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground" title={t('permissionCount', { count: r.capabilityCount })}>
                        {r.memberCount}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          {selected ? (
            <AddonRoleEditor
              // a fresh editor (and fresh draft) for each role, and again after it is saved or reloaded
              key={`${selected.id}:${selected.name}:${selected.description ?? ''}:${(selected.capabilities ?? []).join(',')}`}
              entry={selected}
              editorCaps={editorCaps}
              onChanged={refetch}
              onDeleted={() => {
                setSelectedId(null);
                void refetch();
              }}
            />
          ) : null}
        </div>
      )}

      <NewAddonRoleDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onCreated={(id) => {
          void refetch().then(() => setSelectedId(id));
        }}
      />
    </div>
  );
}
