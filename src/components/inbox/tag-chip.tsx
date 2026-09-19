import { X } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { Tag } from '@/types';

/**
 * One coloured chip for a contact tag or a conversation label, used by
 * the conversation list, the thread header and the right-hand column so
 * the same colour reads the same everywhere. The two kinds look
 * different on purpose: a tag (about the person) is an outlined pill
 * with a dot, a label (about the conversation) is a filled tint.
 */
export function TagChip({
  tag,
  kind,
  size = 'sm',
  title,
  onRemove,
  removeLabel,
  className,
}: {
  tag: Pick<Tag, 'name' | 'color'>;
  kind: 'tag' | 'label';
  size?: 'xs' | 'sm';
  title?: string;
  onRemove?: () => void;
  removeLabel?: string;
  className?: string;
}) {
  return (
    <span
      title={title ?? tag.name}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-full font-medium',
        size === 'xs' ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-0.5 text-[10px]',
        className,
      )}
      style={
        kind === 'tag'
          ? { color: tag.color, border: `1px solid ${tag.color}66`, backgroundColor: `${tag.color}12` }
          : { color: tag.color, border: '1px solid transparent', backgroundColor: `${tag.color}26` }
      }
    >
      {kind === 'tag' ? (
        <span
          className={cn('shrink-0 rounded-full', size === 'xs' ? 'size-1' : 'size-1.5')}
          style={{ backgroundColor: tag.color }}
        />
      ) : null}
      <span className={cn('truncate', size === 'xs' && 'max-w-16')}>{tag.name}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="-mr-0.5 shrink-0 rounded-full p-0.5 opacity-60 transition-opacity hover:bg-black/10 hover:opacity-100 dark:hover:bg-white/10"
        >
          <X className="size-2.5" />
        </button>
      ) : null}
    </span>
  );
}
