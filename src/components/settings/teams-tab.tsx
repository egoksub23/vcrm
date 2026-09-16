'use client';

// ============================================================
// TeamsTab — Settings → Teams
//
// P0 gap-analysis item: group agents by specialty (Tech, Compliance,
// Payments, …) so conversations can be routed to a group instead of
// one named agent. Mirrors MembersTab's shape — roster + admin-gated
// mutation controls — but each roster is scoped to a team instead of
// the whole account, and every team also gets a color swatch used
// for chips elsewhere (inbox buckets, automation step badges).
//
// Role-gating mirrors MembersTab: any member can view; RequireRole
// gates every mutating control. The API routes double-check admin+
// server-side regardless.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  Boxes,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  UserPlus,
  X,
} from 'lucide-react';

import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
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
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useTranslations } from 'next-intl';
import { RequireRole } from '@/components/auth/require-role';
import { cn } from '@/lib/utils';
import type { AccountMember, Team, TeamMember } from '@/types';
import { SettingsPanelHead } from './settings-panel-head';

const PRESET_COLORS = [
  { name: 'red', value: '#ef4444' },
  { name: 'orange', value: '#f97316' },
  { name: 'amber', value: '#f59e0b' },
  { name: 'emerald', value: '#10b981' },
  { name: 'cyan', value: '#06b6d4' },
  { name: 'blue', value: '#3b82f6' },
  { name: 'violet', value: '#8b5cf6' },
  { name: 'pink', value: '#ec4899' },
];

interface TeamFormValues {
  name: string;
  description: string;
  color: string;
}

const BLANK_FORM: TeamFormValues = {
  name: '',
  description: '',
  color: PRESET_COLORS[5].value,
};

export function TeamsTab() {
  const t = useTranslations('Settings.teams');
  const tColors = useTranslations('Settings.tagsAndFields');

  const [teams, setTeams] = useState<Team[]>([]);
  const [accountMembers, setAccountMembers] = useState<AccountMember[]>([]);
  const [loading, setLoading] = useState(true);

  const [formOpen, setFormOpen] = useState(false);
  const [editingTeam, setEditingTeam] = useState<Team | null>(null);
  const [deletingTeam, setDeletingTeam] = useState<Team | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [teamsRes, membersRes] = await Promise.all([
        fetch('/api/account/teams', { cache: 'no-store' }),
        fetch('/api/account/members', { cache: 'no-store' }),
      ]);
      if (!teamsRes.ok) {
        const payload = await teamsRes.json().catch(() => ({}));
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      const teamsJson = (await teamsRes.json()) as { teams: Team[] };
      setTeams(teamsJson.teams);

      if (membersRes.ok) {
        const membersJson = (await membersRes.json()) as { members: AccountMember[] };
        setAccountMembers(membersJson.members);
      }
    } catch (err) {
      console.error('[TeamsTab] load error:', err);
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setEditingTeam(null);
    setFormOpen(true);
  }

  function openEdit(team: Team) {
    setEditingTeam(team);
    setFormOpen(true);
  }

  async function handleDelete() {
    if (!deletingTeam) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/account/teams/${deletingTeam.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('deleteFailed'));
        return;
      }
      toast.success(t('teamDeleted'));
      setTeams((prev) => prev.filter((tm) => tm.id !== deletingTeam.id));
      setDeletingTeam(null);
    } catch (err) {
      console.error('[TeamsTab] delete error:', err);
      toast.error(t('networkError'));
    } finally {
      setDeleting(false);
    }
  }

  function handleTeamMembersChange(teamId: string, members: TeamMember[]) {
    setTeams((prev) =>
      prev.map((tm) => (tm.id === teamId ? { ...tm, members } : tm)),
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <RequireRole min="admin">
            <Button onClick={openCreate}>
              <Plus className="size-4" />
              {t('createTeam')}
            </Button>
          </RequireRole>
        }
      />

      {teams.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Boxes className="size-6 text-muted-foreground" />
            <p className="mt-2 text-sm text-muted-foreground">{t('noTeamsTitle')}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t('noTeamsDesc')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {teams.map((team) => (
            <TeamCard
              key={team.id}
              team={team}
              accountMembers={accountMembers}
              onEdit={() => openEdit(team)}
              onDelete={() => setDeletingTeam(team)}
              onMembersChange={(members) => handleTeamMembersChange(team.id, members)}
              t={t}
            />
          ))}
        </div>
      )}

      <TeamFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        team={editingTeam}
        onSaved={(team) => {
          setTeams((prev) => {
            if (editingTeam) {
              return prev.map((tm) => (tm.id === team.id ? { ...tm, ...team } : tm));
            }
            return [...prev, team];
          });
        }}
        t={t}
        tColors={tColors}
      />

      <Dialog
        open={deletingTeam !== null}
        onOpenChange={(open) => {
          if (!open) setDeletingTeam(null);
        }}
      >
        <DialogContent className="bg-popover border-border sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-popover-foreground">
              <AlertTriangle className="size-4 text-amber-400" />
              {t('deleteTeam')}
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t('deleteConfirm', { name: deletingTeam?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="bg-popover border-border">
            <Button
              variant="outline"
              onClick={() => setDeletingTeam(null)}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              {t('cancel')}
            </Button>
            <Button
              onClick={handleDelete}
              disabled={deleting}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {deleting ? (
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
    </section>
  );
}

// ------------------------------------------------------------
// TeamCard — one team's identity + member roster
// ------------------------------------------------------------

function TeamCard({
  team,
  accountMembers,
  onEdit,
  onDelete,
  onMembersChange,
  t,
}: {
  team: Team;
  accountMembers: AccountMember[];
  onEdit: () => void;
  onDelete: () => void;
  onMembersChange: (members: TeamMember[]) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [addingUserId, setAddingUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [pendingRemoveUserId, setPendingRemoveUserId] = useState<string | null>(null);

  const members = team.members ?? [];
  const memberIds = new Set(members.map((m) => m.user_id));
  const eligible = accountMembers.filter((m) => !memberIds.has(m.user_id));

  async function handleAdd() {
    if (!addingUserId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/account/teams/${team.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: addingUserId }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('addMemberFailed'));
        return;
      }
      const { member } = (await res.json()) as { member: TeamMember };
      onMembersChange([...members, member]);
      setAddingUserId('');
    } catch (err) {
      console.error('[TeamCard] add member error:', err);
      toast.error(t('networkError'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(userId: string) {
    setPendingRemoveUserId(userId);
    try {
      const res = await fetch(`/api/account/teams/${team.id}/members/${userId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('removeMemberFailed'));
        return;
      }
      onMembersChange(members.filter((m) => m.user_id !== userId));
    } catch (err) {
      console.error('[TeamCard] remove member error:', err);
      toast.error(t('networkError'));
    } finally {
      setPendingRemoveUserId(null);
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <span
              className="size-3 shrink-0 rounded-full"
              style={{ backgroundColor: team.color }}
              aria-hidden
            />
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-foreground">
                {team.name}
              </h3>
              {team.description && (
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">
                  {team.description}
                </p>
              )}
            </div>
          </div>
          <RequireRole min="admin">
            <div className="flex shrink-0 items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={onEdit}
                aria-label={t('editAria', { name: team.name })}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                <Pencil className="size-3.5" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onDelete}
                aria-label={t('deleteAria', { name: team.name })}
                className="border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20 hover:border-red-500/60 hover:text-red-200"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </RequireRole>
        </div>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            {t('membersTitle')} · {t('memberCount', { count: members.length })}
          </p>
          {members.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('noMembersYet')}</p>
          ) : (
            <ul className="space-y-1.5">
              {members.map((member) => (
                <li
                  key={member.user_id}
                  className="flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5"
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <Avatar className="size-6 shrink-0">
                      {member.avatar_url ? (
                        <AvatarImage src={member.avatar_url} alt={member.full_name || t('unnamed')} />
                      ) : null}
                      <AvatarFallback className="bg-primary/10 text-[10px] font-medium text-primary">
                        {(member.full_name || member.email || 'U').charAt(0).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="truncate text-xs text-foreground">
                      {member.full_name || t('unnamed')}
                    </span>
                  </div>
                  <RequireRole min="admin">
                    <button
                      type="button"
                      onClick={() => handleRemove(member.user_id)}
                      disabled={pendingRemoveUserId === member.user_id}
                      aria-label={t('removeMemberAria', { name: member.full_name || t('unnamed') })}
                      className="shrink-0 rounded-full p-0.5 text-muted-foreground opacity-60 transition-opacity hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
                    >
                      <X className="size-3" />
                    </button>
                  </RequireRole>
                </li>
              ))}
            </ul>
          )}
        </div>

        <RequireRole min="admin">
          {eligible.length > 0 ? (
            <div className="flex items-center gap-2">
              <Select value={addingUserId} onValueChange={(v) => v && setAddingUserId(v)}>
                <SelectTrigger className="flex-1 bg-muted border-border text-foreground">
                  <SelectValue placeholder={t('selectMember')} />
                </SelectTrigger>
                <SelectContent>
                  {eligible.map((m) => (
                    <SelectItem key={m.user_id} value={m.user_id}>
                      {m.full_name || m.email || m.user_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={handleAdd}
                disabled={!addingUserId || busy}
                className="shrink-0 border-border text-foreground hover:bg-muted"
              >
                <UserPlus className="size-3.5" />
                {t('addMember')}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t('noEligibleMembers')}</p>
          )}
        </RequireRole>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------
// TeamFormDialog — shared create + edit
// ------------------------------------------------------------

function TeamFormDialog({
  open,
  onOpenChange,
  team,
  onSaved,
  t,
  tColors,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  team: Team | null;
  onSaved: (team: Team) => void;
  t: ReturnType<typeof useTranslations>;
  tColors: ReturnType<typeof useTranslations>;
}) {
  const isEdit = team !== null;
  const [values, setValues] = useState<TeamFormValues>(BLANK_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setValues(
      team
        ? { name: team.name, description: team.description ?? '', color: team.color }
        : BLANK_FORM,
    );
  }, [open, team]);

  async function handleSubmit() {
    const name = values.name.trim();
    if (!name) {
      toast.error(t('nameRequired'));
      return;
    }
    setSaving(true);
    try {
      const url = isEdit ? `/api/account/teams/${team!.id}` : '/api/account/teams';
      const res = await fetch(url, {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          description: values.description.trim(),
          color: values.color,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || (isEdit ? t('updateFailed') : t('createFailed')));
        return;
      }
      const { team: saved } = (await res.json()) as { team: Team };
      toast.success(isEdit ? t('teamUpdated') : t('teamCreated'));
      onSaved(isEdit ? { ...team, ...saved } : { ...saved, members: [] });
      onOpenChange(false);
    } catch (err) {
      console.error('[TeamFormDialog] save error:', err);
      toast.error(t('networkError'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {isEdit ? t('edit') : t('createTeam')}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('nameLabel')}
            </label>
            <Input
              value={values.name}
              onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))}
              placeholder={t('namePlaceholder')}
              maxLength={60}
              className="bg-muted text-foreground"
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('descriptionLabel')}
            </label>
            <Textarea
              value={values.description}
              onChange={(e) => setValues((v) => ({ ...v, description: e.target.value }))}
              placeholder={t('descriptionPlaceholder')}
              maxLength={240}
              className="bg-muted text-foreground"
              rows={2}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground">
              {t('colorLabel')}
            </label>
            <div className="flex gap-1.5">
              {PRESET_COLORS.map((color) => (
                <button
                  key={color.value}
                  type="button"
                  onClick={() => setValues((v) => ({ ...v, color: color.value }))}
                  aria-label={tColors('useColor', {
                    color: tColors(`colors.${color.name}` as Parameters<typeof tColors>[0]),
                  })}
                  aria-pressed={values.color === color.value}
                  className={cn(
                    'size-6 rounded-md transition-transform hover:scale-110',
                    values.color === color.value &&
                      'outline outline-2 outline-offset-2 outline-primary',
                  )}
                  style={{ backgroundColor: color.value }}
                  title={tColors(`colors.${color.name}` as Parameters<typeof tColors>[0])}
                />
              ))}
            </div>
          </div>
        </div>

        <DialogFooter className="bg-popover border-border">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-border text-muted-foreground hover:bg-muted"
          >
            {t('cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {isEdit ? t('saving') : t('creating')}
              </>
            ) : isEdit ? (
              t('save')
            ) : (
              t('create')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
