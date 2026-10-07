"use client";

// ============================================================
// Doc Sign, a new document collection (the envelopes of migration 171): choose two to six documents (files of the sender's own, any number at
// once or one by one, and templates, in any mix), see them as ONE ordered list that can be reordered and trimmed, give the collection a title
// and its contact, ticket and deal, and create it. Each document is made by the same service a document alone is made by, and the sender goes to
// the collection's own screen for the people, the options and the sending. Used on its own page (/sign/new/envelope) and inside the New document
// page when "Document collection" is chosen (`embedded`, with the contact, ticket and deal held by the page so a choice is never lost).
// ============================================================

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowLeft, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCapability } from "@/hooks/use-can";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { collectionRequest, sizeOk, type CollectionItem } from "@/lib/sign/client/collection-list";
import { errorKey } from "@/lib/sign/client/errors";
import { linksAfterContactChange, linksAfterRecord } from "@/lib/sign/client/record-links";
import { ENVELOPE_MAX_DOCUMENTS, ENVELOPE_MIN_DOCUMENTS } from "@/lib/sign/envelopes";
import { cn } from "@/lib/utils";

import { ContactPicker } from "../send/contact-picker";
import { RecordPicker } from "../send/record-picker";
import { CollectionList, CollectionPicker } from "./collection-builder";

export interface CollectionLinks {
  contactId: string | null;
  ticketId: string | null;
  dealId: string | null;
}

interface Props {
  contactId?: string | null;
  ticketId?: string | null;
  dealId?: string | null;
  /** Inside the New document page: no heading of its own and no permission screen (the page has both), and the links are the page's. */
  embedded?: boolean;
  links?: CollectionLinks;
  onLinks?: (next: CollectionLinks) => void;
}

interface Created {
  envelope: { id: string };
}

export function NewEnvelope({ contactId: initialContact = null, ticketId: initialTicket = null, dealId: initialDeal = null, embedded = false, links: controlled, onLinks }: Props) {
  const t = useTranslations("Sign.send.collection.builder");
  const tNew = useTranslations("Sign.send.new");
  const tErr = useTranslations("Sign.send");
  const tRec = useTranslations("Sign.send.records");
  const router = useRouter();
  const canSend = useCapability("sign.send");

  const [items, setItems] = useState<CollectionItem<File>[]>([]);
  const [title, setTitle] = useState("");
  const [own, setOwn] = useState<CollectionLinks>({ contactId: initialContact, ticketId: initialTicket, dealId: initialDeal });
  const links = controlled ?? own;
  const setLinks = (next: CollectionLinks) => {
    setOwn(next);
    onLinks?.(next);
  };
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const total = items.length;
  const ready = sizeOk(total);

  const change = (next: CollectionItem<File>[]) => {
    setErrorCode(null);
    setItems(next);
  };

  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErrorCode(null);
    try {
      const request = collectionRequest(items, { title: title.trim(), contactId: links.contactId, ticketId: links.ticketId, dealId: links.dealId });
      const created = await signRequest<Created>("/api/sign/envelopes", request);
      router.push(`/sign/envelopes/${created.envelope.id}`);
    } catch (err) {
      setErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      setBusy(false);
    }
  };

  if (!canSend && !embedded) {
    return (
      <div className="mx-auto mt-10 max-w-md rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground" role="status">
        <p className="mb-3">{tNew("noPermission")}</p>
        <Link href="/sign" className="text-primary underline-offset-4 hover:underline">
          {tNew("backToDocuments")}
        </Link>
      </div>
    );
  }

  return (
    <div className={cn("space-y-5", !embedded && "mx-auto max-w-3xl")}>
      {embedded ? null : (
        <div>
          <Link href="/sign" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" aria-hidden />
            {tNew("backToDocuments")}
          </Link>
          <h1 className="mt-2 text-xl font-semibold text-foreground">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
      )}

      <section aria-labelledby="coll-choose" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div>
          <h2 id="coll-choose" className="text-sm font-semibold text-foreground">
            {t("chooseHeading")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("chooseHint", { min: ENVELOPE_MIN_DOCUMENTS, max: ENVELOPE_MAX_DOCUMENTS })}</p>
        </div>
        <CollectionPicker items={items} onItems={change} max={ENVELOPE_MAX_DOCUMENTS} disabled={busy} />
      </section>

      <section aria-labelledby="coll-order" className="space-y-2 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="coll-order" className="text-sm font-semibold text-foreground">
          {t("orderHeading", { count: total, max: ENVELOPE_MAX_DOCUMENTS })}
        </h2>
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">{t("nothingChosen")}</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">{t("orderHint")}</p>
            <CollectionList items={items} onItems={change} disabled={busy} />
          </>
        )}
        <p className={cn("text-xs", ready ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300")} role="status">
          {total < ENVELOPE_MIN_DOCUMENTS ? t("needMore", { min: ENVELOPE_MIN_DOCUMENTS }) : total >= ENVELOPE_MAX_DOCUMENTS ? t("full", { max: ENVELOPE_MAX_DOCUMENTS }) : t("count", { count: total, max: ENVELOPE_MAX_DOCUMENTS })}
        </p>
      </section>

      <section aria-labelledby="coll-details" className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="coll-details" className="text-sm font-semibold text-foreground">
          {tNew("detailsHeading")}
        </h2>
        <div className="space-y-1.5">
          <label htmlFor="coll-title" className="text-sm font-medium text-foreground">
            {t("titleLabel")} <span className="font-normal text-muted-foreground">({tNew("optional")})</span>
          </label>
          <Input id="coll-title" maxLength={200} value={title} disabled={busy} placeholder={t("titlePlaceholder")} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="coll-contact" className="text-sm font-medium text-foreground">
              {tNew("contactLabel")} <span className="font-normal text-muted-foreground">({tNew("optional")})</span>
            </label>
            <ContactPicker id="coll-contact" contactId={links.contactId} onChange={(c) => setLinks(linksAfterContactChange(links, c?.id ?? null))} disabled={busy} />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="coll-ticket" className="text-sm font-medium text-foreground">
              {tRec("ticketLabel")} <span className="font-normal text-muted-foreground">({tNew("optional")})</span>
            </label>
            <RecordPicker id="coll-ticket" kind="ticket" value={links.ticketId} contactId={links.contactId} disabled={busy} onChange={(r) => setLinks(linksAfterRecord(links, "ticket", r))} />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="coll-deal" className="text-sm font-medium text-foreground">
              {tRec("dealLabel")} <span className="font-normal text-muted-foreground">({tNew("optional")})</span>
            </label>
            <RecordPicker id="coll-deal" kind="deal" value={links.dealId} contactId={links.contactId} disabled={busy} onChange={(r) => setLinks(linksAfterRecord(links, "deal", r))} />
          </div>
        </div>
      </section>

      {errorCode ? (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{tErr(errorKey(errorCode))}</p>
        </div>
      ) : null}

      {busy ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {t("creating")}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2">
        <Link href="/sign" className="inline-flex h-9 items-center rounded-lg px-3 text-sm text-muted-foreground hover:text-foreground">
          {tNew("cancel")}
        </Link>
        <Button type="button" size="lg" disabled={!ready || busy} onClick={() => void create()}>
          {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("create")}
        </Button>
      </div>
    </div>
  );
}
