'use client';

import { AlertTriangle, ArrowRight, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { capabilityI18nId } from '@/lib/auth/capabilities';
import type { AccountRole } from '@/lib/auth/roles';
import { cn } from '@/lib/utils';
import type { ChangeSummary } from './helpers';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: AccountRole;
  memberCount: number;
  summary: ChangeSummary;
  saving: boolean;
  /** Server message from a failed save, kept inline; the draft is kept. */
  error: string | null;
  onConfirm: () => void;
}

/** Lists what will change and warns when real people are affected. */
export function ConfirmDialog({
  open,
  onOpenChange,
  role,
  memberCount,
  summary,
  saving,
  error,
  onConfirm,
}: ConfirmDialogProps) {
  const t = useTranslations('Permissions');
  const tRoles = useTranslations('Settings.roles');
  const roleName = tRoles(role);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Never dismiss mid-save: the request is already in flight.
        if (!saving) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('dialog.title', { role: roleName })}
          </DialogTitle>
          <DialogDescription>
            {t('dialog.description', { count: summary.items.length })}
          </DialogDescription>
        </DialogHeader>

        {memberCount > 0 ? (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-700 dark:text-amber-300"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <div className="space-y-1">
              <p className="font-medium">
                {t('dialog.peopleAffected', {
                  count: memberCount,
                  role: roleName,
                })}
              </p>
              <p>
                {summary.lost > 0
                  ? t('dialog.loseTiming', { lost: summary.lost })
                  : t('dialog.gainTiming', { gained: summary.gained })}
              </p>
            </div>
          </div>
        ) : (
          <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
            {t('dialog.nobodyAffected', { role: roleName })}
          </p>
        )}

        {summary.hiddenMenus.length > 0 ? (
          <p className="flex items-start gap-2 text-sm text-foreground">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-amber-500"
              aria-hidden
            />
            <span>
              {t('dialog.warnMenus', { count: summary.hiddenMenus.length })}
            </span>
          </p>
        ) : null}
        {summary.removesRolesManage ? (
          <p className="flex items-start gap-2 text-sm text-foreground">
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-amber-500"
              aria-hidden
            />
            <span>{t('dialog.warnRolesManage', { role: roleName })}</span>
          </p>
        ) : null}

        <div className="max-h-[40dvh] space-y-3 overflow-y-auto rounded-lg border border-border p-3">
          {summary.groups.map((block) => (
            <div key={block.group}>
              <h4 className="mb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {t(`group.${block.group}`)}
              </h4>
              <ul className="space-y-1">
                {block.items.map((item) => (
                  <li
                    key={item.key}
                    className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-sm"
                  >
                    <span className="text-foreground">
                      {t(`cap.${capabilityI18nId(item.key)}.label`)}
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <span className="text-muted-foreground">
                        {item.from ? t('dialog.on') : t('dialog.off')}
                      </span>
                      <ArrowRight
                        className="size-3 text-muted-foreground"
                        aria-label={t('dialog.to')}
                      />
                      <span
                        className={cn(
                          'font-medium',
                          item.to
                            ? 'text-emerald-600 dark:text-emerald-300'
                            : 'text-red-600 dark:text-red-300',
                        )}
                      >
                        {item.to ? t('dialog.on') : t('dialog.off')}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        {error ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t('dialog.cancel')}
          </Button>
          <Button onClick={onConfirm} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('dialog.saving')}
              </>
            ) : (
              t('dialog.confirm')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
