"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { formatDistanceToNow } from "date-fns";
import { Flag, Loader2, Plus, Ticket as TicketIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useTeams } from "@/hooks/use-teams";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { contactHandle } from "@/lib/whatsapp/wa-identity";
import { CreateTicketDialog } from "@/components/tickets/create-ticket-dialog";
import { TicketDetailSheet } from "@/components/tickets/ticket-detail-sheet";
import type { Contact, Profile, Ticket, TicketPriority, TicketStatus } from "@/types";

const PRIORITY_COLOR: Record<TicketPriority, string> = {
  urgent: "text-red-500",
  high: "text-amber-500",
  normal: "text-muted-foreground",
  low: "text-sky-500",
};

const STATUS_COLOR: Record<TicketStatus, string> = {
  open: "bg-sky-500/10 text-sky-500",
  pending: "bg-amber-500/10 text-amber-500",
  resolved: "bg-emerald-500/10 text-emerald-500",
  closed: "bg-muted text-muted-foreground",
};

interface TicketRow extends Ticket {
  contact?: Contact;
}

const STATUS_FILTERS = ["all", "open", "pending", "resolved", "closed"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

// `useSearchParams` opts the page out of static prerendering unless it
// sits under a Suspense boundary — same reason Settings/Reports do this.
export default function TicketsPage() {
  return (
    <Suspense fallback={null}>
      <TicketsPageInner />
    </Suspense>
  );
}

function TicketsPageInner() {
  const t = useTranslations("Tickets.list");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  const { teams } = useTeams();

  const [rows, setRows] = useState<TicketRow[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("open");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("all");
  const [teamFilter, setTeamFilter] = useState<string>("all");
  const [createOpen, setCreateOpen] = useState(false);

  const openTicketId = searchParams.get("t");

  const load = useCallback(async () => {
    setLoading(true);
    const supabase = createClient();
    const [{ data: ticketRows }, { data: profileRows }] = await Promise.all([
      supabase
        .from("tickets")
        .select("*, contact:contacts(*)")
        .order("created_at", { ascending: false }),
      supabase.from("profiles").select("*").order("full_name"),
    ]);
    setRows((ticketRows as TicketRow[]) ?? []);
    setProfiles((profileRows as Profile[]) ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Realtime — any insert/update to tickets in this account refreshes
  // the list (RLS already scopes what comes through).
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("tickets-list")
      .on("postgres_changes", { event: "*", schema: "public", table: "tickets" }, () => {
        void load();
      })
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [load]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (statusFilter !== "all" && r.status !== statusFilter) return false;
      if (assigneeFilter === "mine" && r.assigned_agent_id !== user?.id) return false;
      if (assigneeFilter === "unassigned" && r.assigned_agent_id) return false;
      if (teamFilter !== "all" && r.assigned_team_id !== teamFilter) return false;
      return true;
    });
  }, [rows, statusFilter, assigneeFilter, teamFilter, user?.id]);

  const openTicket = (id: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("t", id);
    router.replace(`/tickets?${params.toString()}`, { scroll: false });
  };

  const closeTicket = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("t");
    router.replace(params.toString() ? `/tickets?${params.toString()}` : "/tickets", {
      scroll: false,
    });
  };

  const assigneeName = (agentId: string | null | undefined) =>
    profiles.find((p) => p.user_id === agentId)?.full_name ?? null;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("pageTitle")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("pageDesc")}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          {t("newTicket")}
        </Button>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border border-border bg-muted/40 p-0.5">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-medium transition-colors",
                statusFilter === s
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t(`statusFilter.${s}`)}
            </button>
          ))}
        </div>

        <Select value={assigneeFilter} onValueChange={(v) => setAssigneeFilter(v ?? "all")}>
          <SelectTrigger className="w-40 bg-muted">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("assigneeFilter.all")}</SelectItem>
            <SelectItem value="mine">{t("assigneeFilter.mine")}</SelectItem>
            <SelectItem value="unassigned">{t("assigneeFilter.unassigned")}</SelectItem>
          </SelectContent>
        </Select>

        {teams.length > 0 && (
          <Select value={teamFilter} onValueChange={(v) => setTeamFilter(v ?? "all")}>
            <SelectTrigger className="w-40 bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("teamFilter.all")}</SelectItem>
              {teams.map((team) => (
                <SelectItem key={team.id} value={team.id}>
                  {team.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-border bg-card">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-primary" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
            <TicketIcon className="size-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-16">{t("col.number")}</TableHead>
                <TableHead>{t("col.subject")}</TableHead>
                <TableHead>{t("col.contact")}</TableHead>
                <TableHead>{t("col.status")}</TableHead>
                <TableHead>{t("col.priority")}</TableHead>
                <TableHead>{t("col.assignee")}</TableHead>
                <TableHead className="text-right">{t("col.updated")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((row) => (
                <TableRow
                  key={row.id}
                  onClick={() => openTicket(row.id)}
                  className="cursor-pointer"
                >
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    #{row.ticket_number}
                  </TableCell>
                  <TableCell className="max-w-xs truncate font-medium text-foreground">
                    {row.subject}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {row.contact?.name || (row.contact ? contactHandle(row.contact) : "—")}
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                        STATUS_COLOR[row.status],
                      )}
                    >
                      {t(`status.${row.status}`)}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 text-xs font-medium",
                        PRIORITY_COLOR[row.priority],
                      )}
                    >
                      <Flag className="size-3" />
                      {t(`priority.${row.priority}`)}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {assigneeName(row.assigned_agent_id) ?? t("unassigned")}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(row.updated_at), { addSuffix: true })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>

      <CreateTicketDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(ticket) => {
          setRows((prev) => [ticket as TicketRow, ...prev]);
          openTicket(ticket.id);
        }}
      />

      <TicketDetailSheet
        ticketId={openTicketId}
        onOpenChange={(open) => !open && closeTicket()}
        onChanged={() => void load()}
      />
    </div>
  );
}
