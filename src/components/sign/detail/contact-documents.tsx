"use client";

// ============================================================
// Doc Sign: the "Documents" tab on a contact. Every document that was made for this contact, newest first, with
// its status and a link to it, and a button to send another (it opens the new-document page with the contact set).
// Read from the browser through row level security (menu.sign); the tab is only offered to people who have it.
// ============================================================

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { FileSignature, Loader2, Plus } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { useCapability } from "@/hooks/use-can";
import { createClient } from "@/lib/supabase/client";
import { documentBadgeClass, documentStatusKey, SIGN_STATUS_NAMESPACE } from "@/lib/sign/client/status";
import { cn } from "@/lib/utils";

import { formatDay } from "./format";

interface Row {
  id: string;
  reference: string | null;
  title: string;
  status: string;
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
}

type State = { contactId: string; rows: Row[] | null };

export function ContactDocuments({ contactId }: { contactId: string }) {
  const t = useTranslations("Sign.detail");
  const ts = useTranslations(SIGN_STATUS_NAMESPACE);
  const locale = useLocale();
  const canSend = useCapability("sign.send");
  const [state, setState] = useState<State | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await createClient()
        .from("sign_documents")
        .select("id, reference, title, status, created_at, sent_at, completed_at")
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(100);
      if (cancelled) return;
      if (error) console.error("[sign] could not read the contact's documents:", error.message);
      setState({ contactId, rows: error ? null : ((data ?? []) as Row[]) });
    })();
    return () => {
      cancelled = true;
    };
  }, [contactId, attempt]);

  const mine = state && state.contactId === contactId ? state : null;
  const sendLink = `/sign/new?contactId=${encodeURIComponent(contactId)}`;

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground">{t("contactTab.title")}</h3>
        {canSend && (
          <Link href={sendLink} className={cn(buttonVariants({ size: "sm" }))}>
            <Plus aria-hidden />
            {t("contactTab.send")}
          </Link>
        )}
      </div>

      {mine === null && (
        <div className="flex items-center justify-center py-8" role="status" aria-label={t("loading")}>
          <Loader2 className="size-5 animate-spin text-primary" aria-hidden />
        </div>
      )}

      {mine && mine.rows === null && (
        <div className="grid justify-items-start gap-2" role="alert">
          <p className="text-xs text-destructive">{t("contactTab.failed")}</p>
          <Button size="sm" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
            {t("retry")}
          </Button>
        </div>
      )}

      {mine && mine.rows && mine.rows.length === 0 && <p className="text-xs text-muted-foreground">{t("contactTab.empty")}</p>}

      {mine && mine.rows && mine.rows.length > 0 && (
        <ul className="grid gap-2">
          {mine.rows.map((r) => (
            <li key={r.id}>
              <Link href={`/sign/${r.id}`} className="flex items-start gap-3 rounded-lg border border-border bg-muted/50 p-3 transition-colors hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
                <FileSignature className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1">
                  <span className="block break-words text-sm font-medium text-foreground">{r.title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {r.reference ? `${r.reference} · ` : ""}
                    {formatDay(r.completed_at ?? r.sent_at ?? r.created_at, locale)}
                  </span>
                </span>
                <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium", documentBadgeClass(r.status))}>{ts(documentStatusKey(r.status))}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
