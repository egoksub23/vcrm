'use client';

// ============================================================
// TeamsView — Settings → Team → Teams
//
// A card per team: colour, name, description, member avatars (+N), member
// count and how many open conversations are assigned to the team. Click a
// card to open the team panel (members, quick add / remove). Create, edit
// and delete need teams.manage.
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Boxes,
  Inbox,
  Loader2,
  Pencil,
  Trash2,
  Users,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { RequireCapability } from '@/components/auth/require-capability';
import { membersOfTeam } from '@/lib/teams/members';
import type { Team } from '@/types';
import { initialOf } from './member-parts';
import { TeamFormDialog } from './team-form-dialog';
import { TeamSheet } from './team-sheet';
import type { TeamRoster } from './use-team-roster';

const AVATAR_LIMIT = 5;

export function TeamsView({
  roster,
  formOpen,
  onFormOpenChange,
  editing,
  onEdit,
}: {
  roster: TeamRoster;
  /** The create / edit dialog is owned by the parent (header button). */
  formOpen: boolean;
  onFormOpenChange: (open: boolean) => void;
  editing: Team | null;
  onEdit: (team: Team) => void;
}) {
  const t = useTranslations('Settings.team.teams');
  const { teams, members, loading, reload } = roster;

  const [openId, setOpenId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Team | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleDelete() {
    if (!deleting) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/account/teams/${deleting.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('deleteFailed'));
        return;
      }
      toast.success(t('teamDeleted'));
      setDeleting(null);
      await reload();
    } catch (err) {
      console.error('[TeamsView] delete error:', err);
      toast.error(t('networkError'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  const openTeam = teams.find((tm) => tm.id === openId) ?? null;

  return (
    <div className="space-y-4">
      {teams.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Boxes className="size-6 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">
              {t('noTeamsTitle')}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('noTeamsDesc')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {teams.map((team) => {
            const people = membersOfTeam(members, team.id);
            const shown = people.slice(0, AVATAR_LIMIT);
            const rest = people.length - shown.length;
            return (
              <Card key={team.id} className="overflow-hidden">
                <div
                  className="h-1"
                  style={{ backgroundColor: team.color }}
                  aria-hidden
                />
                <CardContent className="space-y-4 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => setOpenId(team.id)}
                      className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-primary"
                      aria-label={t('openTeam', { name: team.name })}
                    >
                      <span className="flex items-center gap-2">
                        <span
                          className="size-3 shrink-0 rounded-full"
                          style={{ backgroundColor: team.color }}
                          aria-hidden
                        />
                        <span className="truncate text-sm font-semibold text-foreground">
                          {team.name}
                        </span>
                      </span>
                      {team.description ? (
                        <span className="mt-1 line-clamp-2 block text-xs text-muted-foreground">
                          {team.description}
                        </span>
                      ) : null}
                    </button>
                    <RequireCapability cap="teams.manage">
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onEdit(team)}
                          aria-label={t('editAria', { name: team.name })}
                          className="border-border text-muted-foreground hover:bg-muted"
                        >
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setDeleting(team)}
                          aria-label={t('deleteAria', { name: team.name })}
                          className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </RequireCapability>
                  </div>

                  <div className="flex min-h-8 items-center">
                    {people.length === 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {t('noMembersYet')}
                      </span>
                    ) : (
                      <AvatarGroup>
                        {shown.map((p) => (
                          <Avatar key={p.user_id} size="sm">
                            {p.avatar_url ? (
                              <AvatarImage
                                src={p.avatar_url}
                                alt={p.full_name || p.email || ''}
                              />
                            ) : null}
                            <AvatarFallback className="bg-primary/10 text-[10px] font-medium text-primary">
                              {initialOf(p.full_name, p.email)}
                            </AvatarFallback>
                          </Avatar>
                        ))}
                        {rest > 0 && (
                          <AvatarGroupCount className="text-xs">
                            +{rest}
                          </AvatarGroupCount>
                        )}
                      </AvatarGroup>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1.5">
                      <Users className="size-3.5" />
                      {t('memberCount', { count: people.length })}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Inbox className="size-3.5" />
                      {t('openConversations', {
                        count: team.open_conversations ?? 0,
                      })}
                    </span>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <TeamSheet
        team={openTeam}
        roster={roster}
        onClose={() => setOpenId(null)}
      />

      <TeamFormDialog
        open={formOpen}
        onOpenChange={onFormOpenChange}
        team={editing}
        onSaved={reload}
      />

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setDeleting(null);
        }}
      >
        <DialogContent className="border-border bg-popover sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <AlertTriangle className="size-4 text-amber-400" />
              {t('deleteTeam')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteConfirm', { name: deleting?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-border bg-popover">
            <Button
              variant="outline"
              onClick={() => setDeleting(null)}
              disabled={busy}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleDelete}
              disabled={busy}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {busy ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('deleting')}
                </>
              ) : (
                t('deleteTeam')
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
