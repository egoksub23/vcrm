'use client';

// Small shared pieces of the Team screen: the person avatar (optionally
// with a presence badge) and the role lozenge.

import { useTranslations } from 'next-intl';

import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarImage,
} from '@/components/ui/avatar';
import type { AccountRole } from '@/lib/auth/roles';
import type { PresenceStatus } from '@/lib/presence';
import { PRESENCE_DOT_CLASS } from '@/components/presence/presence-dot';
import { cn } from '@/lib/utils';
import { ROLE_META } from '../role-meta';

export function initialOf(name: string, email: string | null): string {
  return (name || email || 'U').trim().charAt(0).toUpperCase() || 'U';
}

export function MemberAvatar({
  name,
  email,
  src,
  className,
  presence,
  presenceLabel,
}: {
  name: string;
  email: string | null;
  src: string | null;
  className?: string;
  presence?: PresenceStatus;
  /** Announced by screen readers for the presence badge. */
  presenceLabel?: string;
}) {
  return (
    <Avatar className={cn('size-9 shrink-0', className)}>
      {src ? <AvatarImage src={src} alt={name || email || ''} /> : null}
      <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
        {initialOf(name, email)}
      </AvatarFallback>
      {presence ? (
        <AvatarBadge
          role="img"
          aria-label={presenceLabel}
          className={PRESENCE_DOT_CLASS[presence]}
        />
      ) : null}
    </Avatar>
  );
}

export function RoleLozenge({
  role,
  className,
}: {
  role: AccountRole;
  className?: string;
}) {
  const tRoles = useTranslations('Settings.roles');
  const meta = ROLE_META[role];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium',
        meta.className,
        className,
      )}
    >
      <Icon className="size-3" />
      {tRoles(role)}
    </span>
  );
}
