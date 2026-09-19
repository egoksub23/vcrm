'use client';

import { useState } from 'react';
import { Check, Plus } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { Tag } from '@/types';

/**
 * "+" button that opens a searchable list of tags / labels to toggle.
 * Selection state lives in the parent (`selectedIds`); `onToggle` does
 * the write. The list stays open so several can be picked in a row.
 */
export function TagPicker({
  options,
  selectedIds,
  onToggle,
  disabled,
  addLabel,
  searchPlaceholder,
  emptyLabel,
  noMatchesLabel,
}: {
  options: Tag[];
  selectedIds: Set<string>;
  onToggle: (tag: Tag) => void | Promise<void>;
  disabled?: boolean;
  addLabel: string;
  searchPlaceholder: string;
  /** Shown when there is nothing to pick at all (nothing created yet). */
  emptyLabel: string;
  noMatchesLabel: string;
}) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = q ? options.filter((o) => o.name.toLowerCase().includes(q)) : options;

  return (
    <Popover onOpenChange={(open) => (open ? undefined : setQuery(''))}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={addLabel}
        title={addLabel}
        className="inline-flex size-5 items-center justify-center rounded-full border border-dashed border-border text-muted-foreground transition-colors hover:border-primary hover:text-primary disabled:pointer-events-none disabled:opacity-50"
      >
        <Plus className="size-3" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-60 gap-0 p-0">
        {options.length === 0 ? (
          <p className="px-3 py-3 text-xs text-muted-foreground">{emptyLabel}</p>
        ) : (
          <>
            <div className="border-b border-border p-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="h-8 text-xs"
                autoFocus
              />
            </div>
            <div className="max-h-56 overflow-y-auto p-1">
              {shown.length === 0 ? (
                <p className="px-2 py-2 text-xs text-muted-foreground">{noMatchesLabel}</p>
              ) : (
                shown.map((option) => {
                  const selected = selectedIds.has(option.id);
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => onToggle(option)}
                      aria-pressed={selected}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-muted',
                        selected && 'bg-muted/60',
                      )}
                    >
                      <span
                        className="size-2 shrink-0 rounded-full"
                        style={{ backgroundColor: option.color }}
                      />
                      <span className="min-w-0 flex-1 truncate">{option.name}</span>
                      {selected ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
                    </button>
                  );
                })
              )}
            </div>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
