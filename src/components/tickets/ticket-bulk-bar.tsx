"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, Loader2, Trash2, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { TICKET_PRIORITIES, TICKET_STATUSES } from "@/lib/tickets/constants";
import { normalizeLabel, suggestLabels } from "@/lib/tickets/labels";
import { JiraBulkActions, type BulkTicket } from "./jira-bulk-dialogs";
import type { BulkAction } from "@/lib/tickets/patch";
import type { Profile, Team } from "@/types";
import { PersonAvatar, PriorityIcon, StatusLozenge } from "./ticket-visuals";

function BarMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50">
        {label}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="max-h-72 w-56 border-border bg-popover">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Shown while list rows are ticked: change status, assignee, priority or team,
 * or add a label, for all of them at once. The page runs each as one update
 * for all the ids and confirms the count. Delete appears only for people who
 * may delete tickets.
 */
export function TicketBulkBar({
  count,
  members,
  teams,
  knownLabels,
  canDelete,
  busy,
  onApply,
  onDelete,
  onClear,
  jiraTickets,
  onJiraDone,
}: {
  count: number;
  members: Profile[];
  teams: Team[];
  knownLabels: { label: string; uses: number }[];
  canDelete: boolean;
  busy: boolean;
  onApply: (action: BulkAction) => void;
  onDelete: () => void;
  onClear: () => void;
  /** The selected tickets, for "Create Jira issues" / "Link to Jira issue" (shown with jira.link and a connection). */
  jiraTickets?: BulkTicket[];
  onJiraDone?: () => void;
}) {
  const t = useTranslations("Tickets.bulk");
  const tCommon = useTranslations("Tickets.common");
  const [labelOpen, setLabelOpen] = useState(false);
  const [labelText, setLabelText] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const applyLabel = (raw: string) => {
    if (!normalizeLabel(raw)) return;
    onApply({ kind: "label", label: raw });
    setLabelText("");
    setLabelOpen(false);
  };
  const suggestions = suggestLabels(knownLabels, [], labelText, 6);

  return (
    <div
      role="region"
      aria-label={t("region")}
      className="sticky bottom-3 z-20 mx-auto mt-3 flex w-fit max-w-full flex-wrap items-center gap-2 rounded-xl border border-border bg-popover px-3 py-2 shadow-lg"
    >
      <span className="text-[13px] font-medium">{t("selected", { count })}</span>
      {busy ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}

      <BarMenu label={t("status")}>
        {TICKET_STATUSES.map((s) => (
          <DropdownMenuItem key={s} onClick={() => onApply({ kind: "status", status: s })}>
            <StatusLozenge status={s} />
          </DropdownMenuItem>
        ))}
      </BarMenu>

      <BarMenu label={t("assign")}>
        <DropdownMenuItem onClick={() => onApply({ kind: "assignee", userId: null })}>
          <PersonAvatar name="" size="sm" className="bg-muted text-muted-foreground" />
          {tCommon("unassigned")}
        </DropdownMenuItem>
        {members.map((m) => (
          <DropdownMenuItem key={m.user_id} onClick={() => onApply({ kind: "assignee", userId: m.user_id })}>
            <PersonAvatar name={m.full_name} avatarUrl={m.avatar_url} size="sm" />
            <span className="truncate">{m.full_name}</span>
          </DropdownMenuItem>
        ))}
      </BarMenu>

      <BarMenu label={t("priority")}>
        {TICKET_PRIORITIES.map((p) => (
          <DropdownMenuItem key={p} onClick={() => onApply({ kind: "priority", priority: p })}>
            <PriorityIcon priority={p} withLabel />
          </DropdownMenuItem>
        ))}
      </BarMenu>

      {teams.length > 0 ? (
        <BarMenu label={t("team")}>
          <DropdownMenuItem onClick={() => onApply({ kind: "team", teamId: null })}>{tCommon("noTeam")}</DropdownMenuItem>
          {teams.map((tm) => (
            <DropdownMenuItem key={tm.id} onClick={() => onApply({ kind: "team", teamId: tm.id })}>
              <span className="truncate">{tm.name}</span>
            </DropdownMenuItem>
          ))}
        </BarMenu>
      ) : null}

      <Popover open={labelOpen} onOpenChange={setLabelOpen}>
        <PopoverTrigger className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-[13px] outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50">
          {t("addLabel")}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </PopoverTrigger>
        <PopoverContent align="start" side="top" className="w-60">
          <Input
            value={labelText}
            onChange={(e) => setLabelText(e.target.value)}
            placeholder={t("labelPlaceholder")}
            maxLength={40}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") applyLabel(labelText);
            }}
          />
          <div className="flex flex-col">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => applyLabel(s)}
                className="rounded px-2 py-1 text-left text-[13px] hover:bg-muted"
              >
                {s}
              </button>
            ))}
            {normalizeLabel(labelText) && !suggestions.includes(normalizeLabel(labelText)) ? (
              <button
                type="button"
                onClick={() => applyLabel(labelText)}
                className="rounded px-2 py-1 text-left text-[13px] text-primary hover:bg-muted"
              >
                {t("createLabel", { label: normalizeLabel(labelText) })}
              </button>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>

      {jiraTickets && jiraTickets.length > 0 ? <JiraBulkActions tickets={jiraTickets} onDone={onJiraDone} /> : null}

      {canDelete ? (
        <Button variant="destructive" size="sm" onClick={() => setConfirmOpen(true)} disabled={busy}>
          <Trash2 className="size-3.5" />
          {t("delete")}
        </Button>
      ) : null}

      <button
        type="button"
        onClick={onClear}
        className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
        {t("clear")}
      </button>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="bg-popover text-popover-foreground sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("deleteTitle", { count })}</DialogTitle>
            <DialogDescription>{t("deleteDescription")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmOpen(false);
                onDelete();
              }}
            >
              {t("deleteConfirm", { count })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
