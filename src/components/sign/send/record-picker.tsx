"use client";

// ============================================================
// "Link to a ticket / a deal" (F-51): a small searchable picker over the workspace's tickets or deals. With a contact chosen on the
// document it offers only that contact's records (the server refuses any other); without one it offers the most recent, and choosing
// one fills the contact (the parent does that: lib/sign/client/record-links.ts). Read through row level security with the browser
// client, like the contact picker beside it.
// ============================================================

import { useEffect, useId, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { recordSearchClause, ticketLabel, type RecordKind, type RecordOption } from "@/lib/sign/client/record-links";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

interface TicketRow {
  id: string;
  ticket_number: number;
  subject: string;
  status: string;
  contact_id: string | null;
}
interface DealRow {
  id: string;
  title: string;
  status: string | null;
  value: number | null;
  currency: string | null;
  contact_id: string | null;
}

const TICKET_COLUMNS = "id, ticket_number, subject, status, contact_id";
const DEAL_COLUMNS = "id, title, status, value, currency, contact_id";

const ticketOption = (r: TicketRow): RecordOption => ({ id: r.id, label: ticketLabel(r.ticket_number, r.subject), sub: r.status, contactId: r.contact_id });
const dealOption = (r: DealRow): RecordOption => ({
  id: r.id,
  label: r.title,
  sub: [r.status, r.value ? `${r.currency ?? ""} ${r.value}`.trim() : null].filter(Boolean).join(" · "),
  contactId: r.contact_id,
});

async function findOne(kind: RecordKind, id: string): Promise<RecordOption | null> {
  const supabase = createClient();
  if (kind === "ticket") {
    const { data } = await supabase.from("tickets").select(TICKET_COLUMNS).eq("id", id).maybeSingle();
    return data ? ticketOption(data as TicketRow) : null;
  }
  const { data } = await supabase.from("deals").select(DEAL_COLUMNS).eq("id", id).maybeSingle();
  return data ? dealOption(data as DealRow) : null;
}

async function search(kind: RecordKind, query: string, contactId: string | null): Promise<RecordOption[]> {
  const supabase = createClient();
  const clause = recordSearchClause(kind, query);
  if (kind === "ticket") {
    let req = supabase.from("tickets").select(TICKET_COLUMNS);
    if (contactId) req = req.eq("contact_id", contactId);
    if (clause) req = req.or(clause);
    const { data } = await req.order("created_at", { ascending: false }).limit(8);
    return ((data as TicketRow[] | null) ?? []).map(ticketOption);
  }
  let req = supabase.from("deals").select(DEAL_COLUMNS);
  if (contactId) req = req.eq("contact_id", contactId);
  if (clause) req = req.or(clause);
  const { data } = await req.order("created_at", { ascending: false }).limit(8);
  return ((data as DealRow[] | null) ?? []).map(dealOption);
}

interface Props {
  kind: RecordKind;
  /** The chosen record's id, or null. */
  value: string | null;
  /** The document's contact: only that contact's records are offered. */
  contactId: string | null;
  onChange: (record: RecordOption | null) => void;
  disabled?: boolean;
  id?: string;
}

export function RecordPicker({ kind, value, contactId, onChange, disabled, id }: Props) {
  const t = useTranslations("Sign.send.records");
  const { accountId } = useAuth();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<{ key: string; rows: RecordOption[] } | null>(null);
  const [resolved, setResolved] = useState<RecordOption | null>(null);

  const selected = value && resolved?.id === value ? resolved : null;

  // show what an id is when it arrives as an id only (opened from a ticket or a deal, or a saved draft)
  useEffect(() => {
    if (!value || !accountId || resolved?.id === value) return;
    let cancelled = false;
    void (async () => {
      const one = await findOne(kind, value);
      if (!cancelled) setResolved(one ?? { id: value, label: t("unknown"), sub: "", contactId: null });
    })();
    return () => {
      cancelled = true;
    };
  }, [value, kind, accountId, resolved?.id, t]);

  const key = `${contactId ?? ""}|${query}`;
  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    const handle = setTimeout(
      async () => {
        const rows = await search(kind, query, contactId);
        if (cancelled) return;
        setFound({ key, rows });
        setActive(0);
      },
      query.trim() ? 250 : 0,
    );
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, query, contactId, kind, accountId, key]);

  const rows = found?.rows ?? [];
  const searching = open && (!found || found.key !== key);
  const pick = (r: RecordOption) => {
    setResolved(r);
    setOpen(false);
    setQuery("");
    onChange(r);
  };

  if (value && !selected) {
    return (
      <div className="flex h-10 items-center gap-2 rounded-lg border border-input bg-background px-3 text-xs text-muted-foreground" role="status">
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {t("loading")}
      </div>
    );
  }

  if (selected) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 py-1.5">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{selected.label}</p>
          {selected.sub ? <p className="truncate text-xs text-muted-foreground">{selected.sub}</p> : null}
        </div>
        <Button type="button" variant="ghost" size="icon-sm" disabled={disabled} aria-label={t("remove")} onClick={() => onChange(null)}>
          <X />
        </Button>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && rows[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          className="pl-8"
          placeholder={t(kind === "ticket" ? "ticketPlaceholder" : "dealPlaceholder")}
          disabled={disabled}
          value={query}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(rows.length - 1, a + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(0, a - 1));
            } else if (e.key === "Enter" && open && rows[active]) {
              e.preventDefault();
              pick(rows[active]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
        />
      </div>
      {open ? (
        <ul id={listId} role="listbox" aria-label={t("results")} className="absolute z-20 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-md">
          {searching ? (
            <li role="presentation" className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              {t("searching")}
            </li>
          ) : rows.length === 0 ? (
            <li role="presentation" className="px-2 py-2 text-xs text-muted-foreground">
              {contactId ? t("noneForContact") : t("none")}
            </li>
          ) : (
            rows.map((r, i) => (
              <li
                key={r.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={cn("cursor-pointer rounded-md px-2 py-1.5", i === active && "bg-muted")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(r);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <p className="truncate text-sm font-medium">{r.label}</p>
                {r.sub ? <p className="truncate text-xs text-muted-foreground">{r.sub}</p> : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
