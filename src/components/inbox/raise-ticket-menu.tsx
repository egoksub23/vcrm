"use client";

// ============================================================
// The Inbox conversation header's ONE "Raise ticket" control.
//
// Where the workspace has Compliance on and the person holds `compliance.raise`, it is a menu: "Technical or information ticket" opens the create-ticket dialog
// (as the old button did) and "Compliance request" opens the compliance raise dialog (the dialog the ticket page's button opens too). Where Compliance is off
// (the operator's flag removes every `compliance.*` capability) or the person may not raise, it is the old single button that opens the ticket dialog
// directly, with no menu. The status chips of what this person raised on the conversation sit beside it, as RaiseCompliance shows them on a ticket.
//
// The create-ticket dialog stays mounted by the thread (it needs the contact), so this control only asks for it to open.
// ============================================================

import { ChevronDown, ClipboardSignature, Ticket as TicketIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";

import { RaiseComplianceDialog, RaisedChips, useRaised } from "@/components/compliance/raise";
import { readOnlyTitle } from "@/components/ui/gated-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useCapability } from "@/hooks/use-can";
import { cn } from "@/lib/utils";

const TRIGGER =
  "inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export interface RaiseMenuEntry {
  key: "technical" | "compliance";
  disabled: boolean;
  /** Why it is disabled, in the words the thread's other read-only controls use. */
  reason?: string;
}

/**
 * The menu's entries, in order. The compliance entry exists only while the person may raise one (the capability goes away with the workspace's flag);
 * the ticket entry is switched off, with the usual read-only reason, for a person who may not work tickets.
 */
export function raiseMenuEntries(complianceAvailable: boolean, canWorkTickets: boolean): RaiseMenuEntry[] {
  const entries: RaiseMenuEntry[] = [{ key: "technical", disabled: !canWorkTickets, ...(canWorkTickets ? {} : { reason: readOnlyTitle("raise tickets") }) }];
  if (complianceAvailable) entries.push({ key: "compliance", disabled: false });
  return entries;
}

export function RaiseTicketMenu({ conversationId, canWorkTickets, onRaiseTicket, className }: { conversationId: string; canWorkTickets: boolean; onRaiseTicket: () => void; className?: string }) {
  const t = useTranslations("Inbox.messageThread");
  const tMenu = useTranslations("Inbox.raiseMenu");
  const complianceAvailable = useCapability("compliance.raise");
  const canOpen = useCapability("menu.compliance");
  const target = useMemo(() => ({ conversationId }), [conversationId]);
  const [raiseOpen, setRaiseOpen] = useState(false);
  const { items, refresh } = useRaised(target, complianceAvailable);
  const label = t("raiseTicket");

  // Compliance is off for this workspace or person: the old single button, straight to the ticket dialog.
  if (!complianceAvailable) {
    return (
      <button
        type="button"
        onClick={onRaiseTicket}
        disabled={!canWorkTickets}
        title={canWorkTickets ? label : readOnlyTitle("raise tickets")}
        aria-label={label}
        className={cn(TRIGGER, className)}
      >
        <TicketIcon className="h-3 w-3" aria-hidden />
        <span className="hidden sm:inline">{label}</span>
      </button>
    );
  }

  const entries = raiseMenuEntries(true, canWorkTickets);
  return (
    <div className={cn("flex max-w-full flex-wrap items-center gap-1.5", className)}>
      <RaisedChips items={items} canOpen={canOpen} />
      <DropdownMenu>
        <DropdownMenuTrigger title={label} aria-label={label} className={TRIGGER}>
          <TicketIcon className="h-3 w-3" aria-hidden />
          <span className="hidden sm:inline">{label}</span>
          <ChevronDown className="h-3 w-3" aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 max-w-[calc(100vw-1rem)] border-border bg-popover">
          {entries.map((e) => (
            <DropdownMenuItem
              key={e.key}
              disabled={e.disabled}
              title={e.reason}
              onClick={() => (e.key === "technical" ? onRaiseTicket() : setRaiseOpen(true))}
              className="items-start py-1.5 text-sm whitespace-normal"
              data-raise-entry={e.key}
            >
              {e.key === "technical" ? <TicketIcon className="mt-0.5 h-3.5 w-3.5" aria-hidden /> : <ClipboardSignature className="mt-0.5 h-3.5 w-3.5" aria-hidden />}
              <span className="min-w-0 break-words">{tMenu(e.key)}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <RaiseComplianceDialog open={raiseOpen} onOpenChange={setRaiseOpen} target={target} canOpen={canOpen} onRaised={() => void refresh()} />
    </div>
  );
}
