"use client";

// ============================================================
// Doc Sign: the "Documents" panel on a contact, a ticket or a deal. Every document that was made for that record, newest first,
// with its status and a link to it, and a button to send another (it opens the new-document page with the record set: a ticket or a
// deal also carries its contact, so the document shows on the contact's tab too). Read from the browser through row level security
// (menu.sign); the panel is only offered to people who have it. One component for the three records (F-50, F-51): the contact's tab
// is `ContactDocuments`, the ticket and the deal use `RecordDocuments` directly.
// ============================================================

import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { FileSignature, Loader2, Plus } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { useCapability } from "@/hooks/use-can";
import { DOCUMENT_COLUMN, newDocumentHref, type PanelKind } from "@/lib/sign/client/record-links";
import { createClient } from "@/lib/supabase/client";
import { documentBadgeClass, documentStatusKey, SIGN_STATUS_NAMESPACE } from "@/lib/sign/client/status";
import { cn } from "@/lib/utils";

import { formatDay } from "./format";

export interface Row {
  id: string;
  reference: string | null;
  title: string;
  status: string;
  test?: boolean;
  created_at: string;
  sent_at: string | null;
  completed_at: string | null;
}

type State = { key: string; rows: Row[] | null };

interface Props {
  kind: PanelKind;
  /** The id of the contact, the ticket or the deal. */
  id: string;
  /** For a ticket or a deal: the record's contact, so a document sent from here is for that person (the server fills it from the record too). */
  contactId?: string | null;
}

/** The documents of a record, or the sentence that there are none. Each row says Test when it was sent to try a template out. */
export function DocumentRows({ rows, kind }: { rows: readonly Row[]; kind: PanelKind }) {
  const t = useTranslations("Sign.detail");
  const ts = useTranslations(SIGN_STATUS_NAMESPACE);
  const locale = useLocale();
  if (rows.length === 0) return <p className="text-xs text-muted-foreground">{t(kind === "contact" ? "contactTab.empty" : kind === "ticket" ? "recordTab.emptyTicket" : "recordTab.emptyDeal")}</p>;
  return (
    <ul className="grid gap-2">
      {rows.map((r) => (
        <li key={r.id}>
          <Link href={`/sign/${r.id}`} className="flex items-start gap-3 rounded-lg border border-border bg-muted/50 p-3 transition-colors hover:border-primary/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
            <FileSignature className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block break-words text-sm font-medium text-foreground">{r.title}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {r.test ? <span className="mr-1.5 inline-flex h-4 items-center rounded bg-red-100 px-1.5 align-middle text-[10px] font-bold tracking-wide text-red-700 uppercase dark:bg-red-950 dark:text-red-300">{t("recordTab.testBadge")}</span> : null}
                {r.reference ? `${r.reference} · ` : ""}
                {formatDay(r.completed_at ?? r.sent_at ?? r.created_at, locale)}
              </span>
            </span>
            <span className={cn("inline-flex h-5 shrink-0 items-center rounded-full px-2 text-xs font-medium", documentBadgeClass(r.status))}>{ts(documentStatusKey(r.status))}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function RecordDocuments({ kind, id, contactId = null }: Props) {
  const t = useTranslations("Sign.detail");
  const canSend = useCapability("sign.send");
  const [state, setState] = useState<State | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = `${kind}:${id}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await createClient()
        .from("sign_documents")
        .select("id, reference, title, status, test, created_at, sent_at, completed_at")
        .eq(DOCUMENT_COLUMN[kind], id)
        .order("created_at", { ascending: false })
        .limit(100);
      if (cancelled) return;
      if (error) console.error(`[sign] could not read the documents of the ${kind}:`, error.message);
      setState({ key, rows: error ? null : ((data ?? []) as Row[]) });
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, id, key, attempt]);

  const mine = state && state.key === key ? state : null;
  const sendLink = newDocumentHref(kind === "contact" ? { contactId: id } : { contactId, ticketId: kind === "ticket" ? id : null, dealId: kind === "deal" ? id : null });

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

      {mine && mine.rows && <DocumentRows rows={mine.rows} kind={kind} />}
    </div>
  );
}

/** The contact's tab (F-50). */
export function ContactDocuments({ contactId }: { contactId: string }) {
  return <RecordDocuments kind="contact" id={contactId} />;
}
