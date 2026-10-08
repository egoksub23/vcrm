"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight, Users } from "lucide-react";

import { cn } from "@/lib/utils";
import type { BulkOp } from "@/lib/comments/threads";

import { BulkOpButtons } from "./bulk-bar";

/**
 * One person's many open comments on a post, folded into a single line: "ayakorose645 · 11 comments". Open it to read each comment (rendered by
 * the caller as `children`, each with its own actions); the three buttons act on all of the block's open comments.
 */
export function AuthorBlock({
  label,
  count,
  canWrite,
  busy,
  hasNew,
  defaultExpanded = false,
  initialConfirm,
  onGroupAction,
  children,
}: {
  label: string;
  /** How many open comments the block holds (the number in its title and what the group buttons act on). */
  count: number;
  canWrite: boolean;
  /** A group action is running. */
  busy: boolean;
  /** One of its comments arrived since the person last looked: start it open. */
  hasNew?: boolean;
  defaultExpanded?: boolean;
  initialConfirm?: Extract<BulkOp, "resolve" | "spam" | "hide"> | null;
  onGroupAction: (op: Extract<BulkOp, "resolve" | "spam" | "hide">) => void;
  children: ReactNode;
}) {
  const t = useTranslations("Comments");
  const [open, setOpen] = useState(defaultExpanded || !!hasNew);
  const Chevron = open ? ChevronDown : ChevronRight;
  const name = label || t("unknownAuthor");

  return (
    <li data-author-block className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          title={open ? t("collapse") : t("showEach")}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <Chevron className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <Users className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className={cn("min-w-0 truncate text-sm font-semibold text-foreground")}>{t("authorBlock", { author: name, count })}</span>
        </button>
        {canWrite && <BulkOpButtons count={count} variant="group" busy={busy} onRun={onGroupAction} initialConfirm={initialConfirm} />}
      </div>
      {open && <ul className="space-y-2 border-t border-border px-3 py-3">{children}</ul>}
    </li>
  );
}
