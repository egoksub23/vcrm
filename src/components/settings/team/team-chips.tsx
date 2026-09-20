'use client';

// ============================================================
// TeamChips — every team a member belongs to, as colour-dot chips.
// Up to four show inline; the rest sit behind a "+N" button whose
// popover lists ALL of the member's teams.
// ============================================================

import { useTranslations } from 'next-intl';

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import {
  TEAM_CHIP_LIMIT,
  splitTeamChips,
  type TeamRef,
} from '@/lib/teams/members';

export function TeamChip({
  team,
  className,
}: {
  team: TeamRef;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex max-w-[10rem] items-center gap-1.5 rounded-full border border-border bg-muted/50 px-2 py-0.5 text-xs text-foreground',
        className,
      )}
    >
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: team.color }}
        aria-hidden
      />
      <span className="truncate">{team.name}</span>
    </span>
  );
}

export function TeamChips({
  teams,
  limit = TEAM_CHIP_LIMIT,
  className,
}: {
  teams: TeamRef[];
  limit?: number;
  className?: string;
}) {
  const t = useTranslations('Settings.team.chips');
  const { visible, overflow } = splitTeamChips(teams, limit);

  if (teams.length === 0) {
    return <span className="text-xs text-muted-foreground">{t('none')}</span>;
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)}>
      {visible.map((team) => (
        <TeamChip key={team.id} team={team} />
      ))}
      {overflow > 0 && (
        <Popover>
          <PopoverTrigger
            aria-label={t('showAll', { count: teams.length })}
            className="inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
          >
            {t('more', { count: overflow })}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64">
            <p className="text-xs font-medium text-muted-foreground">
              {t('allTeams', { count: teams.length })}
            </p>
            <ul className="flex max-h-56 flex-col gap-1.5 overflow-y-auto">
              {teams.map((team) => (
                <li key={team.id}>
                  <TeamChip team={team} className="max-w-full" />
                </li>
              ))}
            </ul>
          </PopoverContent>
        </Popover>
      )}
    </div>
  );
}
