"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Link2, Loader2, Plus, Search, X } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LINK_GROUP_ORDER, groupLinks, type LinkGroupKey } from "@/lib/tickets/links";
import { searchTicketsForLink, type LinkedTicket } from "@/hooks/use-ticket-detail";
import type { TicketLink } from "@/types";
import { StatusLozenge, TypeIcon } from "./ticket-visuals";

function AddLinkDialog({
  open,
  onOpenChange,
  ticketId,
  keyOf,
  alreadyLinked,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticketId: string;
  keyOf: (n: number) => string;
  alreadyLinked: Set<string>;
  onAdd: (group: LinkGroupKey, other: LinkedTicket) => Promise<boolean>;
}) {
  const t = useTranslations("Tickets.links");
  const [group, setGroup] = useState<LinkGroupKey>("relates");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<LinkedTicket[]>([]);
  const [searching, setSearching] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !query.trim()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([]);
      return;
    }
    let cancelled = false;
    setSearching(true);
    const handle = setTimeout(() => {
      void searchTicketsForLink(query, ticketId).then((rows) => {
        if (cancelled) return;
        setResults(rows);
        setSearching(false);
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, query, ticketId]);

  const pick = async (other: LinkedTicket) => {
    setBusyId(other.id);
    const ok = await onAdd(group, other);
    setBusyId(null);
    if (ok) {
      onOpenChange(false);
      setQuery("");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("addTitle")}</DialogTitle>
          <DialogDescription>{t("addDescription")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Select value={group} onValueChange={(v) => setGroup((v ?? "relates") as LinkGroupKey)}>
            <SelectTrigger className="w-full bg-muted" aria-label={t("typeLabel")}>
              <SelectValue>{t(`group.${group}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {LINK_GROUP_ORDER.map((g) => (
                <SelectItem key={g} value={g}>
                  {t(`group.${g}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("searchPlaceholder")}
              aria-label={t("searchLabel")}
              autoFocus
              className="h-8 w-full rounded-lg border border-input bg-transparent pr-2 pl-8 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            {searching ? (
              <div className="flex justify-center py-4">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : query.trim() && results.length === 0 ? (
              <p className="py-3 text-center text-xs text-muted-foreground">{t("noResults")}</p>
            ) : (
              <ul>
                {results.map((r) => {
                  const linked = alreadyLinked.has(r.id);
                  return (
                    <li key={r.id}>
                      <button
                        type="button"
                        disabled={busyId !== null}
                        onClick={() => void pick(r)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-muted disabled:opacity-60"
                      >
                        <TypeIcon category={r.category} />
                        <span className="shrink-0 font-mono text-xs text-muted-foreground">{keyOf(r.ticket_number)}</span>
                        <span className="min-w-0 flex-1 truncate">{r.subject}</span>
                        {linked ? <span className="shrink-0 text-[11px] text-muted-foreground">{t("linked")}</span> : null}
                        {busyId === r.id ? <Loader2 className="size-3.5 animate-spin" /> : <StatusLozenge status={r.status} />}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** "Linked tickets": grouped by how they relate (blocks, is blocked by, ...). */
export function TicketLinksSection({
  ticketId,
  links,
  linked,
  keyOf,
  canWork,
  onAdd,
  onRemove,
  onOpenTicket,
}: {
  ticketId: string;
  links: TicketLink[];
  linked: Record<string, LinkedTicket>;
  keyOf: (n: number) => string;
  canWork: boolean;
  onAdd: (group: LinkGroupKey, other: LinkedTicket) => Promise<boolean>;
  onRemove: (linkId: string) => void;
  onOpenTicket: (id: string) => void;
}) {
  const t = useTranslations("Tickets.links");
  const [dialogOpen, setDialogOpen] = useState(false);
  const groups = groupLinks(ticketId, links);
  const alreadyLinked = new Set(groups.flatMap((g) => g.items.map((i) => i.otherId)));

  return (
    <section aria-label={t("title")} className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-[13px] font-semibold text-foreground">
          <Link2 className="size-3.5 text-muted-foreground" />
          {t("title")}
        </h3>
        {canWork ? (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary hover:bg-muted"
          >
            <Plus className="size-3.5" />
            {t("add")}
          </button>
        ) : null}
      </div>

      {groups.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-3 text-center text-xs text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <div className="space-y-2">
          {groups.map((g) => (
            <div key={g.key}>
              <p className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                {t(`group.${g.key}`)}
              </p>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {g.items.map(({ link, otherId }) => {
                  const other = linked[otherId];
                  return (
                    <li key={link.id} className="flex items-center gap-2 px-2 py-1.5 text-[13px]">
                      {other ? (
                        <>
                          <TypeIcon category={other.category} />
                          <button
                            type="button"
                            onClick={() => onOpenTicket(other.id)}
                            className="flex min-w-0 flex-1 items-center gap-2 text-left hover:underline"
                          >
                            <span className="shrink-0 font-mono text-xs text-muted-foreground">
                              {keyOf(other.ticket_number)}
                            </span>
                            <span className="truncate">{other.subject}</span>
                          </button>
                          <StatusLozenge status={other.status} />
                        </>
                      ) : (
                        <span className="flex-1 text-xs text-muted-foreground">{t("unavailable")}</span>
                      )}
                      {canWork ? (
                        <button
                          type="button"
                          onClick={() => onRemove(link.id)}
                          aria-label={t("remove")}
                          title={t("remove")}
                          className="shrink-0 rounded p-1 text-muted-foreground hover:text-destructive"
                        >
                          <X className="size-3.5" />
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      <AddLinkDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        ticketId={ticketId}
        keyOf={keyOf}
        alreadyLinked={alreadyLinked}
        onAdd={onAdd}
      />
    </section>
  );
}
