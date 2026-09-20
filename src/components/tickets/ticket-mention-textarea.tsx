"use client";

import { forwardRef, useImperativeHandle, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";

import { EmojiPicker } from "@/components/emoji/emoji-picker";
import { useEmojiShortcut } from "@/components/emoji/use-emoji-shortcut";
import { cn } from "@/lib/utils";
import type { Profile } from "@/types";
import { PersonAvatar } from "./ticket-visuals";

export interface MentionTextareaHandle {
  focus: () => void;
}

/**
 * A textarea with a lightweight @mention autocomplete (mirrors the inbox's
 * internal-comment picker, scoped here because that one lives inline in the
 * message composer). Reports each person picked through `onMention`; the
 * caller decides which of them still count when it submits. Ctrl/Cmd+Enter
 * calls `onSubmit`, Escape calls `onCancel`.
 */
export const MentionTextarea = forwardRef<
  MentionTextareaHandle,
  {
    value: string;
    onValueChange: (value: string) => void;
    onMention?: (userId: string) => void;
    members: Profile[];
    placeholder?: string;
    rows?: number;
    disabled?: boolean;
    autoFocus?: boolean;
    onFocus?: () => void;
    onSubmit?: () => void;
    onCancel?: () => void;
    className?: string;
    "aria-label"?: string;
  }
>(function MentionTextarea(
  {
    value,
    onValueChange,
    onMention,
    members,
    placeholder,
    rows = 3,
    disabled,
    autoFocus,
    onFocus,
    onSubmit,
    onCancel,
    className,
    "aria-label": ariaLabel,
  },
  ref,
) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  useImperativeHandle(ref, () => ({ focus: () => textareaRef.current?.focus() }));

  // Emoji: the smiley button and the ":" shortcut (the newest trigger wins: an
  // open @mention list and an open ":" list can never both match the same caret).
  const emoji = useEmojiShortcut({ fieldRef: textareaRef, value, onValueChange, enabled: !disabled });

  const handleChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    emoji.handleChange(e);
    const next = e.target.value;
    const caret = textareaRef.current?.selectionStart ?? next.length;
    const match = next.slice(0, caret).match(/(?:^|\s)@(\w*)$/);
    setQuery(match ? match[1] : null);
  };

  const matches =
    query === null
      ? []
      : members.filter((p) => p.full_name.toLowerCase().includes(query.toLowerCase())).slice(0, 6);

  const insert = (person: Profile) => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const at = before.lastIndexOf("@");
    if (at === -1) return;
    onValueChange(`${before.slice(0, at)}@${person.full_name} ${after}`);
    onMention?.(person.user_id);
    setQuery(null);
    requestAnimationFrame(() => el?.focus());
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (emoji.handleKeyDown(e)) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSubmit?.();
    } else if (e.key === "Escape") {
      if (query !== null) {
        setQuery(null);
      } else {
        onCancel?.();
      }
      // Escape edits the box, it must not also close the ticket.
      e.stopPropagation();
    }
  };

  return (
    <div className="relative">
      {query !== null && matches.length > 0 ? (
        <div className="absolute bottom-full left-0 z-20 mb-1 w-56 rounded-lg border border-border bg-popover shadow-md">
          {matches.map((p) => (
            <button
              key={p.user_id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                insert(p);
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-popover-foreground hover:bg-muted"
            >
              <PersonAvatar name={p.full_name} avatarUrl={p.avatar_url} size="sm" />
              {p.full_name}
            </button>
          ))}
        </div>
      ) : null}
      {emoji.suggestions}
      <textarea
        ref={textareaRef}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onSelect={emoji.handleSelect}
        onBlur={emoji.handleBlur}
        onFocus={onFocus}
        placeholder={placeholder}
        rows={rows}
        disabled={disabled}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        className={cn(
          "w-full resize-y rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50 disabled:opacity-60",
          className,
          "pr-9",
        )}
      />
      <EmojiPicker
        disabled={disabled}
        onPick={emoji.insertEmoji}
        returnFocusTo={() => textareaRef.current}
        className="absolute right-1 top-1 h-7 w-7"
      />
    </div>
  );
});
