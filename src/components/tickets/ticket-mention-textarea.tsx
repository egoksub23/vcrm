"use client";

import { forwardRef, useImperativeHandle, useRef, useState, type ChangeEvent, type KeyboardEvent } from "react";
import { useTranslations } from "next-intl";
import { Users } from "lucide-react";

import { EmojiPicker } from "@/components/emoji/emoji-picker";
import { useEmojiShortcut } from "@/components/emoji/use-emoji-shortcut";
import { cn } from "@/lib/utils";
import type { Profile } from "@/types";
import { PersonAvatar } from "./ticket-visuals";

export interface MentionTextareaHandle {
  focus: () => void;
}

/** A team the @ list offers (only teams with someone in them are worth mentioning). */
export interface MentionTeam {
  id: string;
  name: string;
  memberCount: number;
}

/**
 * A textarea with a lightweight @mention autocomplete (mirrors the inbox's
 * internal-comment picker, scoped here because that one lives inline in the
 * message composer). Reports each person picked through `onMention` and each
 * team through `onMentionTeam`; the caller decides which of them still count
 * when it submits. Ctrl/Cmd+Enter calls `onSubmit`, Escape calls `onCancel`.
 */
export const MentionTextarea = forwardRef<
  MentionTextareaHandle,
  {
    value: string;
    onValueChange: (value: string) => void;
    onMention?: (userId: string) => void;
    onMentionTeam?: (teamId: string) => void;
    members: Profile[];
    /** Teams to offer under the people; leave out for a picker of people only. */
    teams?: MentionTeam[];
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
    onMentionTeam,
    members,
    teams,
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
  const t = useTranslations("Tickets.detail.mention");
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
  const teamMatches =
    query === null || !teams
      ? []
      : teams.filter((tm) => tm.memberCount > 0 && tm.name.toLowerCase().includes(query.toLowerCase())).slice(0, 4);

  const insertName = (name: string) => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const after = value.slice(caret);
    const at = before.lastIndexOf("@");
    if (at === -1) return false;
    onValueChange(`${before.slice(0, at)}@${name} ${after}`);
    setQuery(null);
    requestAnimationFrame(() => el?.focus());
    return true;
  };
  const insert = (person: Profile) => {
    if (insertName(person.full_name)) onMention?.(person.user_id);
  };
  const insertTeam = (team: MentionTeam) => {
    if (insertName(team.name)) onMentionTeam?.(team.id);
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
      {query !== null && (matches.length > 0 || teamMatches.length > 0) ? (
        <div className="absolute bottom-full left-0 z-20 mb-1 max-h-72 w-64 overflow-y-auto rounded-lg border border-border bg-popover shadow-md">
          {teamMatches.length > 0 && matches.length > 0 ? (
            <p className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{t("people")}</p>
          ) : null}
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
          {teamMatches.length > 0 ? (
            <p className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-wide text-muted-foreground uppercase">{t("teams")}</p>
          ) : null}
          {teamMatches.map((tm) => (
            <button
              key={tm.id}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                insertTeam(tm);
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-popover-foreground hover:bg-muted"
            >
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Users className="size-3.5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1 truncate">{tm.name}</span>
              <span className="shrink-0 text-[11px] text-muted-foreground">{t("memberCount", { count: tm.memberCount })}</span>
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
