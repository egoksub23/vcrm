'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import type { CustomRoleEntry } from '@/app/api/account/roles/custom/route';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { roleRank, type AccountRole } from '@/lib/auth/roles';

const selectClass =
  'h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary/50';

type Source = { kind: 'base'; role: AccountRole } | { kind: 'custom'; id: string };

function sourceKey(s: Source): string {
  return s.kind === 'base' ? `base:${s.role}` : `custom:${s.id}`;
}

interface NewCustomRoleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editorRole: AccountRole;
  customRoles: readonly CustomRoleEntry[];
  /** Pre-fills "duplicate from" when opened via a role's Duplicate button. */
  duplicateFrom?: CustomRoleEntry | null;
  onCreated: (id: string) => void;
}

/** Create a new custom role from scratch (a built-in tier's current
 *  defaults) or by duplicating another role, built-in or custom. */
export function NewCustomRoleDialog({
  open,
  onOpenChange,
  editorRole,
  customRoles,
  duplicateFrom,
  onCreated,
}: NewCustomRoleDialogProps) {
  const t = useTranslations('Permissions.customRoles');
  const tRoles = useTranslations('Settings.roles');

  const assignableTiers = (['admin', 'agent', 'viewer'] as const).filter(
    (r) => roleRank(r) < roleRank(editorRole),
  );

  const [name, setName] = useState('');
  const [baseRole, setBaseRole] = useState<AccountRole>(assignableTiers[0] ?? 'viewer');
  const [source, setSource] = useState<Source>(
    duplicateFrom ? { kind: 'custom', id: duplicateFrom.id } : { kind: 'base', role: assignableTiers[0] ?? 'viewer' },
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(duplicateFrom ? `${duplicateFrom.name} (Copy)` : '');
    const initialTier = duplicateFrom?.baseRole ?? assignableTiers[0] ?? 'viewer';
    setBaseRole(initialTier);
    setSource(duplicateFrom ? { kind: 'custom', id: duplicateFrom.id } : { kind: 'base', role: initialTier });
    // Only re-derive when the dialog opens or the seed role changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, duplicateFrom]);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed) {
      toast.error(t('nameRequired'));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/account/roles/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, baseRole, source }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; id?: string };
      if (!res.ok || !data.id) {
        toast.error(data.error || t('createFailed'));
        return;
      }
      toast.success(t('created', { name: trimmed }));
      onOpenChange(false);
      onCreated(data.id);
    } catch {
      toast.error(t('createFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('newRoleTitle')}</DialogTitle>
          <DialogDescription>{t('newRoleDescription')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="new-role-name">{t('nameLabel')}</Label>
            <Input
              id="new-role-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t('namePlaceholder')}
              maxLength={80}
              autoFocus
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-role-base">{t('baseTierLabel')}</Label>
            <select
              id="new-role-base"
              className={selectClass}
              value={baseRole}
              onChange={(e) => setBaseRole(e.target.value as AccountRole)}
              disabled={saving}
            >
              {assignableTiers.map((r) => (
                <option key={r} value={r}>
                  {tRoles(r)}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">{t('baseTierHint')}</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="new-role-source">{t('sourceLabel')}</Label>
            <select
              id="new-role-source"
              className={selectClass}
              value={sourceKey(source)}
              onChange={(e) => {
                const [kind, value] = e.target.value.split(':', 2);
                setSource(kind === 'custom' ? { kind: 'custom', id: value } : { kind: 'base', role: value as AccountRole });
              }}
              disabled={saving}
            >
              <optgroup label={t('sourceBuiltIn')}>
                {(['admin', 'agent', 'viewer'] as const).map((r) => (
                  <option key={r} value={`base:${r}`}>
                    {tRoles(r)}
                  </option>
                ))}
              </optgroup>
              {customRoles.length > 0 && (
                <optgroup label={t('sourceCustom')}>
                  {customRoles.map((r) => (
                    <option key={r.id} value={`custom:${r.id}`}>
                      {r.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            <p className="text-xs text-muted-foreground">{t('sourceHint')}</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            {t('cancel')}
          </Button>
          <Button onClick={() => void create()} disabled={saving || !name.trim()}>
            {saving ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : null}
            {t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
