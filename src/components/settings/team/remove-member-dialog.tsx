'use client';

// ============================================================
// RemoveMemberDialog — confirm removing someone from the account.
//
// Shows BEFORE the removal what will happen (from the members list
// counts): team memberships cleared, open conversations and tickets
// unassigned or, if you pick someone, reassigned to them. One database
// transaction does all of it (remove_account_member, migration 083).
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Loader2 } from 'lucide-react';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { roleRank } from '@/lib/auth/roles';
import { memberLabel, type RosterMember } from '@/lib/teams/members';

const NONE = 'none';

export function RemoveMemberDialog({
  member,
  members,
  teamCount,
  onOpenChange,
  onRemoved,
}: {
  member: RosterMember | null;
  members: RosterMember[];
  teamCount: number;
  onOpenChange: (open: boolean) => void;
  onRemoved: () => void | Promise<void>;
}) {
  const t = useTranslations('Settings.team.remove');
  const [reassignTo, setReassignTo] = useState<string>(NONE);
  const [busy, setBusy] = useState(false);

  const name = member ? member.full_name || member.email || t('unnamed') : '';
  const convs = member?.open_conversations ?? 0;
  const tickets = member?.open_tickets ?? 0;
  const hasWork = convs + tickets > 0;

  // Work can go to any other agent or above (viewers cannot hold it).
  const heirs = members.filter(
    (m) => m.user_id !== member?.user_id && roleRank(m.role) >= roleRank('agent'),
  );
  const heir = heirs.find((m) => m.user_id === reassignTo);

  function close(open: boolean) {
    if (busy) return;
    if (!open) setReassignTo(NONE);
    onOpenChange(open);
  }

  async function confirm() {
    if (!member) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/account/members/${member.user_id}/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reassignTo: reassignTo === NONE ? null : reassignTo,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('failed'));
        return;
      }
      toast.success(t('removedToast', { name }));
      setReassignTo(NONE);
      await onRemoved();
    } catch (err) {
      console.error('[RemoveMemberDialog] remove error:', err);
      toast.error(t('networkError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={member !== null} onOpenChange={close}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <AlertTriangle className="size-4 text-amber-400" />
            {t('title')}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t.rich('description', {
              name,
              bold: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
            })}
          </DialogDescription>
        </DialogHeader>

        <ul className="space-y-1.5 rounded-lg border border-border bg-muted/40 p-3 text-sm text-foreground">
          <li>{t('teamsLine', { count: teamCount })}</li>
          <li>{t('conversationsLine', { count: convs })}</li>
          <li>{t('ticketsLine', { count: tickets })}</li>
        </ul>

        {hasWork ? (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('reassignLabel')}
            </label>
            <Select
              value={reassignTo}
              onValueChange={(v) => v && setReassignTo(v)}
            >
              <SelectTrigger className="w-full border-border bg-muted text-foreground">
                <SelectValue>
                  {heir ? memberLabel(heir) : t('leaveUnassigned')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>{t('leaveUnassigned')}</SelectItem>
                {heirs.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {memberLabel(m) || t('unnamed')}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              {heir
                ? t('reassignHint', { name: memberLabel(heir) })
                : t('unassignHint')}
            </p>
          </div>
        ) : null}

        <DialogFooter className="border-border bg-popover">
          <Button
            variant="outline"
            onClick={() => close(false)}
            disabled={busy}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('cancel')}
          </Button>
          <Button
            onClick={confirm}
            disabled={busy}
            className="bg-red-600 text-white hover:bg-red-700"
          >
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {t('removing')}
              </>
            ) : (
              t('confirm')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
