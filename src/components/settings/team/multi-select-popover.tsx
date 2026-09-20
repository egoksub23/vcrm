'use client';

// ============================================================
// MultiSelectPopover — a button that opens a searchable checklist.
//
// Used for the Members filters (teams, roles), the member panel's team
// memberships (each toggle saves immediately), the invite dialog's
// "Teams to join" and the bulk "Add to team / Remove from team" bars.
// It is controlled: the parent owns `selected` and decides what a toggle
// does. An optional `footer` renders under the list (an Apply button).
// ============================================================

import { useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { cn } from '@/lib/utils';

export interface PickerOption {
  id: string;
  label: string;
  /** Colour dot (teams). */
  color?: string;
  /** Secondary text, e.g. an email. */
  hint?: string | null;
}

export function MultiSelectPopover({
  options,
  selected,
  onChange,
  label,
  icon,
  searchPlaceholder,
  emptyLabel,
  disabled = false,
  footer,
  align = 'start',
  className,
  onOpenChange,
}: {
  options: PickerOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  /** Trigger text. */
  label: string;
  icon?: ReactNode;
  searchPlaceholder?: string;
  emptyLabel: string;
  disabled?: boolean;
  footer?: ReactNode;
  align?: 'start' | 'center' | 'end';
  className?: string;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useTranslations('Settings.team.picker');
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) =>
      `${o.label} ${o.hint ?? ''}`.toLowerCase().includes(q),
    );
  }, [options, query]);

  function toggle(id: string) {
    onChange(
      selected.includes(id)
        ? selected.filter((s) => s !== id)
        : [...selected, id],
    );
  }

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) setQuery('');
        onOpenChange?.(open);
      }}
    >
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            type="button"
            variant="outline"
            className={cn(
              'justify-between border-border text-muted-foreground hover:bg-muted',
              className,
            )}
          />
        }
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {icon}
          <span className="truncate">{label}</span>
          {selected.length > 0 && (
            <span className="ml-0.5 inline-flex items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
              {selected.length}
            </span>
          )}
        </span>
        <ChevronDown className="size-3.5 shrink-0 opacity-60" />
      </PopoverTrigger>
      <PopoverContent align={align} className="w-72 p-0">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-3.5 shrink-0 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder ?? t('search')}
            aria-label={searchPlaceholder ?? t('search')}
            className="h-7 border-0 bg-transparent px-0 shadow-none focus-visible:ring-0"
          />
          {selected.length > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
            >
              {t('clear')}
            </button>
          )}
        </div>
        {shown.length === 0 ? (
          <p className="px-3 py-4 text-center text-sm text-muted-foreground">
            {options.length === 0 ? emptyLabel : t('noMatches')}
          </p>
        ) : (
          <div className="max-h-64 overflow-y-auto py-1">
            {shown.map((o) => (
              <label
                key={o.id}
                className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 hover:bg-muted/50"
              >
                <Checkbox
                  checked={selected.includes(o.id)}
                  onCheckedChange={() => toggle(o.id)}
                  aria-label={o.label}
                />
                {o.color ? (
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: o.color }}
                    aria-hidden
                  />
                ) : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-popover-foreground">
                    {o.label}
                  </span>
                  {o.hint ? (
                    <span className="block truncate text-xs text-muted-foreground">
                      {o.hint}
                    </span>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        )}
        {footer ? (
          <div className="border-t border-border p-2">{footer}</div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
