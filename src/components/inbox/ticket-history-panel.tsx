"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { formatDistanceToNow } from "date-fns";
import { Loader2, Plus, Ticket as TicketIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useCapability } from "@/hooks/use-can";
import { useTicketKeyPrefix } from "@/hooks/use-ticket-key-prefix";
import { cn } from "@/lib/utils";
import { isActiveStatus } from "@/lib/tickets/constants";
import { Button } from "@/components/ui/button";
import { CreateTicketDialog } from "@/components/tickets/create-ticket-dialog";
import { TicketDetailDialog } from "@/components/tickets/ticket-detail-dialog";
import { STATUS_DOT } from "@/components/tickets/ticket-visuals";
import { TicketSlaBadge } from "@/components/tickets/ticket-sla-badge";
import type { Ticket, TicketPriority } from "@/types";

type Row = Pick<
  Ticket,
  | "id"
  | "ticket_number"
  | "subject"
  | "status"
  | "priority"
  | "category"
  | "conversation_id"
  | "created_at"
  | "updated_at"
  | "sla_policy_id"
  | "sla_first_response_due_at"
  | "sla_first_response_risk_at"
  | "sla_first_response_state"
  | "sla_resolution_due_at"
  | "sla_resolution_risk_at"
  | "sla_resolution_state"
>;

type Filter = "all" | "active" | "done";

const PRIORITY_TEXT: Record<TicketPriority, string> = {
  urgent: "text-red-500",
  high: "text-amber-500",
  normal: "text-muted-foreground",
  low: "text-sky-500",
};

/**
 * Ticket history for the contact in the open chat, docked between the
 * thread and the contact column so an agent can read past tickets while
 * talking to the customer. Live (realtime on the contact's tickets), and
 * clicking a row opens the same detail sheet as the Tickets page.
 */
export function TicketHistoryPanel({
  contactId,
  conversationId,
}: {
  contactId: string | null;
  conversationId: string | null;
}) {
  const t = useTranslations("Inbox.ticketHistory");
  const tt = useTranslations("Tickets.common");
  const { keyOf } = useTicketKeyPrefix();
  const canRaise = useCapability("tickets.work");

  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [raiseOpen, setRaiseOpen] = useState(false);

  const load = useCallback(async () => {
    if (!contactId) return;
    const { data, error } = await createClient()
      .from("tickets")
      .select(
        "id, ticket_number, subject, status, priority, category, conversation_id, created_at, updated_at, sla_policy_id, sla_first_response_due_at, sla_first_response_risk_at, sla_first_response_state, sla_resolution_due_at, sla_resolution_risk_at, sla_resolution_state",
      )
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) console.error("[TicketHistoryPanel] load failed:", error);
    setRows((data as Row[]) ?? []);
    setLoading(false);
  }, [contactId]);

  useEffect(() => {
    if (!contactId) return;
    // A different contact starts from a clean, loading list.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setRows([]);
    void load();
  }, [contactId, load]);

  useEffect(() => {
    if (!contactId) return;
    const supabase = createClient();
    const channel = supabase
      .channel(`ticket-history-${contactId}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "tickets", filter: `contact_id=eq.${contactId}` },
        () => void load(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [contactId, load]);

  const visible = useMemo(() => {
    if (filter === "all") return rows;
    return rows.filter((r) => (filter === "active" ? isActiveStatus(r.status) : !isActiveStatus(r.status)));
  }, [rows, filter]);

  const activeCount = rows.filter((r) => isActiveStatus(r.status)).length;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
        <TicketIcon className="h-4 w-4 text-primary" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-foreground">{t("title")}</h3>
          <p className="text-[11px] text-muted-foreground">
            {rows.length === 0
              ? t("none")
              : t("summary", { total: rows.length, active: activeCount })}
          </p>
        </div>
        {contactId && canRaise ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={() => setRaiseOpen(true)}
          >
            <Plus className="h-3 w-3" />
            {t("raise")}
          </Button>
        ) : null}
      </div>

      <div className="flex gap-1 border-b border-border px-3 py-2">
        {(["all", "active", "done"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            aria-pressed={filter === f}
            className={cn(
              "rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-colors",
              filter === f
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {t(`filter.${f}`)}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!contactId ? null : loading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          </div>
        ) : visible.length === 0 ? (
          <p className="px-4 py-8 text-center text-xs text-muted-foreground">
            {rows.length === 0 ? t("empty") : t("emptyFiltered")}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(r.id)}
                  className="w-full px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 shrink-0 text-[11px] font-medium text-muted-foreground">
                      {keyOf(r.ticket_number)}
                    </span>
                    <span className="line-clamp-2 min-w-0 flex-1 text-sm font-medium text-foreground">
                      {r.subject}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <span className={cn("h-1.5 w-1.5 rounded-full", STATUS_DOT[r.status])} />
                      {tt(`status.${r.status}`)}
                    </span>
                    {r.priority !== "normal" ? (
                      <span className={PRIORITY_TEXT[r.priority]}>{tt(`priority.${r.priority}`)}</span>
                    ) : null}
                    <span>{formatDistanceToNow(new Date(r.created_at), { addSuffix: true })}</span>
                    <TicketSlaBadge ticket={r} compact />
                    {conversationId && r.conversation_id === conversationId ? (
                      <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                        {t("thisChat")}
                      </span>
                    ) : null}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <TicketDetailDialog
        ticketId={openId}
        onOpenChange={(o) => {
          if (!o) setOpenId(null);
        }}
        onChanged={() => void load()}
        onDeleted={() => void load()}
        onOpenTicket={setOpenId}
      />
      {contactId ? (
        <CreateTicketDialog
          open={raiseOpen}
          onOpenChange={setRaiseOpen}
          contactId={contactId}
          conversationId={conversationId}
          onCreated={() => void load()}
          onOpenCreated={setOpenId}
        />
      ) : null}
    </div>
  );
}
