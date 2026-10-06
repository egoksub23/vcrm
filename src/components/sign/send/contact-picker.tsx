"use client";

import { useEffect, useId, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";

export interface ContactSummary {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
}

const COLUMNS = "id, name, email, phone, company";

export const contactLabel = (c: ContactSummary): string => c.name?.trim() || c.email?.trim() || c.phone?.trim() || c.company?.trim() || "";

/** Characters that would break a PostgREST filter list are dropped. */
const safe = (q: string) => q.replace(/[,()%*\\"]/g, " ").replace(/\s+/g, " ").trim();

interface Props {
  /** The chosen contact's id, or null. */
  contactId: string | null;
  onChange: (contact: ContactSummary | null) => void;
  disabled?: boolean;
  /** Id for the search box, so a label can point at it. */
  id?: string;
}

/**
 * A searchable picker over the workspace's contacts (name, phone, email, company). With a contact chosen it shows
 * who it is with a way to change it. Reads `contacts` through row level security, like the rest of the app.
 */
export function ContactPicker({ contactId, onChange, disabled, id }: Props) {
  const t = useTranslations("Sign.send.contact");
  const { accountId } = useAuth();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [found, setFound] = useState<{ q: string; rows: ContactSummary[] } | null>(null);
  const [resolved, setResolved] = useState<ContactSummary | null>(null);

  const selected = contactId && resolved?.id === contactId ? resolved : null;

  // Show who a contact id is when it arrives as an id only (opened from a contact page, or a saved draft).
  useEffect(() => {
    if (!contactId || !accountId || resolved?.id === contactId) return;
    let cancelled = false;
    void (async () => {
      const { data } = await createClient().from("contacts").select(COLUMNS).eq("id", contactId).maybeSingle();
      if (cancelled) return;
      setResolved((data as ContactSummary | null) ?? { id: contactId, name: null, email: null, phone: null, company: null });
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId, accountId, resolved?.id]);

  // Search as the person types (the most recent contacts when the box is empty).
  useEffect(() => {
    if (!open || !accountId) return;
    let cancelled = false;
    const q = safe(query);
    const handle = setTimeout(async () => {
      let req = createClient().from("contacts").select(COLUMNS).is("deleted_at", null);
      req = q ? req.or(`name.ilike.%${q}%,phone.ilike.%${q}%,email.ilike.%${q}%,company.ilike.%${q}%`) : req.order("created_at", { ascending: false });
      const { data } = await req.limit(8);
      if (cancelled) return;
      setFound({ q: query, rows: (data as ContactSummary[] | null) ?? [] });
      setActive(0);
    }, q ? 250 : 0);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, query, accountId]);

  const rows = found?.rows ?? [];
  const searching = open && (!found || found.q !== query);

  const pick = (c: ContactSummary) => {
    setResolved(c);
    setOpen(false);
    setQuery("");
    onChange(c);
  };

  if (contactId && !selected) {
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
          <p className="truncate text-sm font-medium text-foreground">{contactLabel(selected) || t("unnamed")}</p>
          <p className="truncate text-xs text-muted-foreground">{[selected.email, selected.phone].filter(Boolean).join(" · ")}</p>
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
          placeholder={t("placeholder")}
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
              {t("none")}
            </li>
          ) : (
            rows.map((c, i) => (
              <li
                key={c.id}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={cn("cursor-pointer rounded-md px-2 py-1.5", i === active && "bg-muted")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <p className="truncate text-sm font-medium">{contactLabel(c) || t("unnamed")}</p>
                <p className="truncate text-xs text-muted-foreground">{[c.email, c.phone, c.company].filter(Boolean).join(" · ")}</p>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
