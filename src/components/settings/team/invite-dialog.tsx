'use client';

// ============================================================
// InviteDialog
//
// Two-step modal (the mechanics of the earlier invite dialog, kept):
//   1. Form   — role + teams to join + expiry + optional label → POST
//               creates the invite.
//   2. Result — the share URL, returned ONCE. Copy-to-clipboard, plus a
//               "Send via WhatsApp" deep link.
//
// New: the Role list only holds roles strictly BELOW the inviter's own (an
// Admin sees Agent and Viewer; only the Owner sees Admin), and "Teams to
// join" stores team_ids on the invitation, applied automatically when the
// link is redeemed. The token is stored only as a SHA-256 hash, so once the
// result step is dismissed the link is gone forever.
// ============================================================

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, MessageCircle, Sparkles, Users } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button, buttonVariants } from '@/components/ui/button';
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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAuth } from '@/hooks/use-auth';
import { customRolesBelow, rolesBelow, type AssignableCustomRole, type TeamRef } from '@/lib/teams/members';
import { cn } from '@/lib/utils';
import type { Team } from '@/types';
import { MultiSelectPopover } from './multi-select-popover';
import { TeamChip } from './team-chips';

type InviteRole = 'admin' | 'agent' | 'viewer';

const EXPIRY_OPTIONS = [
  { value: '1', labelKey: 'days1' },
  { value: '7', labelKey: 'days7' },
  { value: '30', labelKey: 'days30' },
] as const;

// Server caps label at 80 chars (see src/app/api/account/invitations/route.ts).
const MAX_LABEL_LEN = 80;

interface CreatedInvite {
  url: string;
  role: InviteRole;
  /** Set when the invite carries a custom role instead of a plain one. */
  customRoleName: string | null;
  expiresInDays: number;
  teams: TeamRef[];
  /** Snapshotted so a later account rename cannot change the message. */
  accountName: string;
  /** Migration 108 — set when this invite was targeted at a specific
   *  email address instead of a plain shareable link. */
  email: string | null;
  /** Migration 109 — whether the server actually sent an invite email
   *  via Resend for this invite. Only meaningful when `email` is set. */
  emailSent: boolean;
  /** Set when Resend was configured but the send itself failed —
   *  distinguished from "not configured" (both leave `emailSent`
   *  false, but only one is worth explaining to the admin). */
  emailError: string | null;
}

export function InviteDialog({
  open,
  onOpenChange,
  teams,
  customRoles = [],
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teams: Team[];
  /** The account's custom roles, for the role picker (empty when the
   *  caller cannot see them — the picker then only offers built-ins). */
  customRoles?: AssignableCustomRole[];
  /** Called after a successful create so the parent reloads the list. */
  onCreated: () => void | Promise<void>;
}) {
  const t = useTranslations('Settings.team.invite');
  const tRoles = useTranslations('Settings.roles');
  const { account, accountRole } = useAuth();
  // Only the Owner can reach the plain-shareable-link path (no email, no
  // SSO identity check) at all, and even for the Owner it is a secondary
  // choice, not the default. Everyone else invites by email only, so the
  // new teammate signs in with SSO (or a password) straight into the
  // account — no link to copy or hand off themselves.
  const isOwner = accountRole === 'owner';
  const [mode, setMode] = useState<'email' | 'link'>('email');
  // Non-owner can never reach 'link' mode, regardless of what `mode` holds
  // (e.g. a remembered choice from a session where they were an Owner).
  const effectiveMode: 'email' | 'link' = isOwner ? mode : 'email';

  const roleOptions = rolesBelow(accountRole);
  const customRoleOptions = customRolesBelow(accountRole, customRoles);
  const [chosenRole, setRole] = useState<InviteRole>('agent');
  // The remembered choice may not be offered to this caller.
  const role: InviteRole = roleOptions.includes(chosenRole)
    ? chosenRole
    : (roleOptions[0] ?? chosenRole);
  const [customRoleId, setCustomRoleId] = useState<string | null>(null);
  const chosenCustomRole = customRoleId ? customRoleOptions.find((r) => r.id === customRoleId) : undefined;
  const [teamIds, setTeamIds] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<string>('7');
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<CreatedInvite | null>(null);

  const teamOptions = useMemo(
    () => teams.map((tm) => ({ id: tm.id, label: tm.name, color: tm.color })),
    [teams],
  );
  const chosenTeams: TeamRef[] = teams
    .filter((tm) => teamIds.includes(tm.id))
    .map((tm) => ({ id: tm.id, name: tm.name, color: tm.color }));

  // The role actually sent: the custom role's own base tier when one is
  // picked (the server requires `role` to match it exactly), else the
  // plain built-in selection.
  const effectiveRole: InviteRole = chosenCustomRole?.baseRole ?? role;

  function reset() {
    setMode('email');
    setRole('agent');
    setCustomRoleId(null);
    setTeamIds([]);
    setExpiry('7');
    setLabel('');
    setEmail('');
    setResult(null);
    setSubmitting(false);
  }

  async function handleCreate() {
    const trimmedLabel = label.trim();
    if (trimmedLabel.length > MAX_LABEL_LEN) {
      toast.error(t('labelTooLong', { max: MAX_LABEL_LEN }));
      return;
    }
    const trimmedEmail = email.trim();
    if (effectiveMode === 'email' && !trimmedEmail) {
      toast.error(t('emailRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/account/invitations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: effectiveRole,
          customRoleId: chosenCustomRole?.id,
          expiresInDays: Number(expiry),
          label: trimmedLabel || undefined,
          teamIds,
          email: trimmedEmail || undefined,
        }),
      });

      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || t('createFailed'));
        return;
      }

      const data = (await res.json()) as {
        url: string;
        expiresInDays: number;
        invitation: { email: string | null };
        emailSent: boolean;
        emailError: string | null;
      };

      setResult({
        url: data.url,
        role: effectiveRole,
        customRoleName: chosenCustomRole?.name ?? null,
        expiresInDays: data.expiresInDays,
        teams: chosenTeams,
        accountName: account?.name ?? t('fallbackAccountName'),
        email: data.invitation.email,
        emailSent: data.emailSent,
        emailError: data.emailError,
      });
      await onCreated();
    } catch (err) {
      console.error('[InviteDialog] create error:', err);
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function copyToClipboard() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.url);
      toast.success(t('copied'));
    } catch {
      // Most likely "not in a secure context" (http:// local IPs).
      toast.error(t('clipboardBlocked'));
    }
  }

  function whatsappShareUrl(url: string): string {
    const accountName = result?.accountName ?? t('fallbackAccountName');
    const message = t('whatsappMessage', {
      accountName,
      expiresInDays: result?.expiresInDays ?? 0,
      url,
    });
    return `https://wa.me/?text=${encodeURIComponent(message)}`;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // The plaintext URL is intentionally NOT preserved across opens.
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="border-border bg-popover sm:max-w-md">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-popover-foreground">
                <Sparkles className="size-4 text-primary" />
                {t('inviteCreated')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t.rich(isOwner || !result.emailSent ? 'inviteCreatedDesc' : 'inviteCreatedDescEmailOnly', {
                  role: result.customRoleName ?? tRoles(result.role),
                  days: result.expiresInDays,
                  email: result.email ?? '',
                  bold: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
                })}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-3 py-2">
              {result.teams.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-muted-foreground">
                    {t('willJoinTeams')}
                  </Label>
                  <div className="flex flex-wrap gap-1">
                    {result.teams.map((tm) => (
                      <TeamChip key={tm.id} team={tm} />
                    ))}
                  </div>
                </div>
              )}

              {result.email && isOwner && (
                <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-foreground">
                  {t.rich('emailAutoJoinHint', {
                    email: result.email,
                    bold: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
                  })}
                </div>
              )}

              {result.email && result.emailSent && (
                <div className="rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200">
                  {t.rich('emailSentHint', {
                    email: result.email,
                    bold: (chunks: React.ReactNode) => <strong>{chunks}</strong>,
                  })}
                </div>
              )}

              {result.email && !result.emailSent && (
                <div className="rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                  {result.emailError ? t('emailSendFailedHint') : t('emailNotConfiguredHint')}
                  {!isOwner ? ` ${t('linkFallbackHint')}` : null}
                </div>
              )}

              {/* The plain link is Owner-only by default (see isOwner above);
                  for everyone else it only surfaces as a fallback when the
                  invite email itself could not be sent. */}
              {isOwner || !result.emailSent ? (
                <>
                  <Label className="text-muted-foreground">{t('inviteLink')}</Label>
                  <div className="flex gap-2">
                    <Input
                      readOnly
                      value={result.url}
                      className="border-border bg-muted font-mono text-xs text-foreground"
                      onFocus={(e) => e.currentTarget.select()}
                    />
                    <Button
                      type="button"
                      onClick={copyToClipboard}
                      className="shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
                    >
                      <Copy className="size-4" />
                      {t('copy')}
                    </Button>
                  </div>

                  <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-900 dark:text-amber-200">
                    <strong className="font-semibold">{t('saveLinkNow')}</strong>{' '}
                    {t('saveLinkHint')}
                  </div>

                  <a
                    href={whatsappShareUrl(result.url)}
                    target="_blank"
                    rel="noreferrer noopener"
                    className={buttonVariants({
                      variant: 'outline',
                      className:
                        'w-full border-border text-muted-foreground hover:bg-muted',
                    })}
                  >
                    <MessageCircle className="size-4" />
                    {t('sendViaWhatsApp')}
                  </a>
                </>
              ) : null}
            </div>

            <DialogFooter className="border-border bg-popover">
              <Button
                onClick={() => onOpenChange(false)}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {t('done')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">
                {t('dialogTitle')}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {effectiveMode === 'link' ? t('dialogDesc') : t('dialogDescEmailOnly')}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-2">
              {isOwner && (
                <div className="inline-flex rounded-lg border border-border bg-muted p-0.5 text-xs">
                  {(['email', 'link'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      className={cn(
                        'rounded-md px-3 py-1.5 font-medium transition-colors',
                        mode === m ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {m === 'email' ? t('modeEmail') : t('modeLink')}
                    </button>
                  ))}
                </div>
              )}

              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('roleLabel')}</Label>
                <Select
                  value={chosenCustomRole ? `custom:${chosenCustomRole.id}` : `role:${role}`}
                  onValueChange={(v) => {
                    if (!v) return;
                    const [kind, val] = v.split(':', 2);
                    if (kind === 'custom') setCustomRoleId(val);
                    else {
                      setCustomRoleId(null);
                      setRole(val as InviteRole);
                    }
                  }}
                >
                  <SelectTrigger className="w-full border-border bg-muted text-foreground">
                    <SelectValue>{chosenCustomRole ? chosenCustomRole.name : tRoles(role)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {roleOptions.map((r) => (
                        <SelectItem key={r} value={`role:${r}`}>
                          {tRoles(r)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                    {customRoleOptions.length > 0 && (
                      <SelectGroup>
                        <SelectSeparator />
                        <SelectLabel>{t('customRolesLabel')}</SelectLabel>
                        {customRoleOptions.map((r) => (
                          <SelectItem key={r.id} value={`custom:${r.id}`}>
                            {r.name}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    )}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {chosenCustomRole
                    ? t('customRoleHint', { role: tRoles(chosenCustomRole.baseRole) })
                    : tRoles(`${role}Hint` as 'adminHint' | 'agentHint' | 'viewerHint')}
                </p>
                <p className="text-xs text-muted-foreground">
                  {accountRole === 'owner'
                    ? t('rolesOwnerHint')
                    : t('rolesBelowHint')}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground" htmlFor="invite-email">
                  {t('emailLabel')}{' '}
                  {effectiveMode === 'link' ? (
                    <span className="text-xs text-muted-foreground">{t('optional')}</span>
                  ) : null}
                </Label>
                <Input
                  id="invite-email"
                  type="email"
                  required={effectiveMode === 'email'}
                  placeholder={t('emailPlaceholder')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
                <p className="text-xs text-muted-foreground">
                  {effectiveMode === 'link' ? t('emailHint') : t('emailHintRequired')}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('teamsLabel')}{' '}
                  <span className="text-xs text-muted-foreground">
                    {t('optional')}
                  </span>
                </Label>
                <MultiSelectPopover
                  options={teamOptions}
                  selected={teamIds}
                  onChange={setTeamIds}
                  label={t('pickTeams')}
                  icon={<Users className="size-3.5" />}
                  searchPlaceholder={t('searchTeams')}
                  emptyLabel={t('noTeamsYet')}
                  className="w-full"
                />
                {chosenTeams.length > 0 ? (
                  <div className="flex flex-wrap gap-1">
                    {chosenTeams.map((tm) => (
                      <TeamChip key={tm.id} team={tm} />
                    ))}
                  </div>
                ) : null}
                <p className="text-xs text-muted-foreground">{t('teamsHint')}</p>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {effectiveMode === 'link' ? t('validForLabel') : t('validForLabelEmail')}
                </Label>
                <Select value={expiry} onValueChange={(v) => v && setExpiry(v)}>
                  <SelectTrigger className="w-full border-border bg-muted text-foreground">
                    <SelectValue>
                      {t(
                        (EXPIRY_OPTIONS.find((o) => o.value === expiry)
                          ?.labelKey ?? 'days7') as 'days7',
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {t(opt.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('labelTitle')}{' '}
                  <span className="text-xs text-muted-foreground">
                    {t('optional')}
                  </span>
                </Label>
                <Input
                  placeholder={t('labelPlaceholder')}
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  maxLength={MAX_LABEL_LEN}
                  className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                />
                <p className="text-xs text-muted-foreground">{t('labelHint')}</p>
              </div>
            </div>

            <DialogFooter className="border-border bg-popover">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={handleCreate}
                disabled={submitting || roleOptions.length === 0}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {submitting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('creating')}
                  </>
                ) : effectiveMode === 'link' ? (
                  t('generateLink')
                ) : (
                  t('sendInvite')
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
