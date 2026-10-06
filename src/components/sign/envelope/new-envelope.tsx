"use client";

// ============================================================
// Doc Sign, "Send as envelope" (migration 171): start an envelope from two to six templates (and optionally one file of the sender's own as the
// first document), a title, and the contact, ticket and deal. Creates the draft envelope, with each document made by the same service a document
// alone is made by, and goes to it. The people, the options and the sending are on the envelope's own screen.
// ============================================================

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowDown, ArrowLeft, ArrowUp, FileText, Loader2, Search, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCapability } from "@/hooks/use-can";
import { useActiveTemplates, type ActiveTemplate } from "@/hooks/use-sign-templates";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { errorKey } from "@/lib/sign/client/errors";
import { linksAfterContactChange, linksAfterRecord } from "@/lib/sign/client/record-links";
import { checkUploadFile } from "@/lib/sign/client/upload";
import { ENVELOPE_MAX_DOCUMENTS, ENVELOPE_MIN_DOCUMENTS } from "@/lib/sign/envelopes";
import { cn } from "@/lib/utils";

import { ContactPicker } from "../send/contact-picker";
import { FileDrop } from "../send/file-drop";
import { RecordPicker } from "../send/record-picker";

interface Props {
  contactId?: string | null;
  ticketId?: string | null;
  dealId?: string | null;
}

interface Created {
  envelope: { id: string };
}

/** Move the item at `index` by `delta` places (clamped); a copy. */
function moved<T>(list: readonly T[], index: number, delta: number): T[] {
  const to = Math.max(0, Math.min(list.length - 1, index + delta));
  if (to === index) return [...list];
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(to, 0, item);
  return next;
}

export function NewEnvelope({ contactId: initialContact = null, ticketId: initialTicket = null, dealId: initialDeal = null }: Props) {
  const t = useTranslations("Sign.send.envelope.new");
  const tNew = useTranslations("Sign.send.new");
  const tErr = useTranslations("Sign.send");
  const tRec = useTranslations("Sign.send.records");
  const router = useRouter();
  const canSend = useCapability("sign.send");
  const { templates, loading, error } = useActiveTemplates();

  const [chosen, setChosen] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [contactId, setContactId] = useState<string | null>(initialContact);
  const [ticketId, setTicketId] = useState<string | null>(initialTicket);
  const [dealId, setDealId] = useState<string | null>(initialDeal);
  const links = { contactId, ticketId, dealId };
  const [busy, setBusy] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const byId = useMemo(() => new Map(templates.map((x) => [x.id, x])), [templates]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return templates.filter((x) => !q || x.name.toLowerCase().includes(q) || (x.description ?? "").toLowerCase().includes(q));
  }, [templates, query]);

  const total = chosen.length + (file ? 1 : 0);
  const ready = total >= ENVELOPE_MIN_DOCUMENTS && total <= ENVELOPE_MAX_DOCUMENTS;

  const toggle = (id: string) => {
    setErrorCode(null);
    setChosen((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length + (file ? 1 : 0) >= ENVELOPE_MAX_DOCUMENTS ? cur : [...cur, id]));
  };
  const chooseFile = (f: File | null) => {
    setErrorCode(null);
    if (f) {
      const problem = checkUploadFile(f);
      if (problem) {
        setFile(null);
        setErrorCode(problem);
        return;
      }
      if (chosen.length >= ENVELOPE_MAX_DOCUMENTS) setChosen((cur) => cur.slice(0, ENVELOPE_MAX_DOCUMENTS - 1));
    }
    setFile(f);
  };

  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErrorCode(null);
    try {
      let created: Created;
      if (file) {
        const form = new FormData();
        form.append("file", file, file.name);
        form.append("templateIds", JSON.stringify(chosen));
        if (title.trim()) form.append("title", title.trim());
        if (contactId) form.append("contactId", contactId);
        if (ticketId) form.append("ticketId", ticketId);
        if (dealId) form.append("dealId", dealId);
        created = await signRequest<Created>("/api/sign/envelopes", { form });
      } else {
        created = await signRequest<Created>("/api/sign/envelopes", { json: { templateIds: chosen, title: title.trim() || undefined, contactId: contactId ?? undefined, ticketId: ticketId ?? undefined, dealId: dealId ?? undefined } });
      }
      router.push(`/sign/envelopes/${created.envelope.id}`);
    } catch (err) {
      setErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      setBusy(false);
    }
  };

  if (!canSend) {
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
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <Link href="/sign" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden />
          {tNew("backToDocuments")}
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-foreground">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <section aria-labelledby="env-choose" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div>
          <h2 id="env-choose" className="text-sm font-semibold text-foreground">
            {t("chooseHeading")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("chooseHint", { min: ENVELOPE_MIN_DOCUMENTS, max: ENVELOPE_MAX_DOCUMENTS })}</p>
        </div>

        {loading ? (
          <div className="space-y-2" role="status" aria-label={tNew("loadingTemplates")}>
            {[0, 1].map((i) => (
              <div key={i} className="h-14 animate-pulse rounded-lg border border-border bg-muted/40" />
            ))}
          </div>
        ) : error ? (
          <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle className="size-4" aria-hidden />
            {tNew("templatesFailed")}
          </p>
        ) : templates.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-5 text-center text-sm text-muted-foreground">
            <p>{tNew("noTemplates")}</p>
            <Link href="/sign/templates" className="mt-1 inline-block text-primary underline-offset-4 hover:underline">
              {tNew("goToTemplates")}
            </Link>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input type="search" aria-label={tNew("searchTemplates")} placeholder={tNew("searchTemplates")} className="h-9 pl-8" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            {shown.length === 0 ? <p className="text-sm text-muted-foreground">{tNew("noTemplateMatch")}</p> : null}
            <ul className="space-y-1.5" aria-label={t("templatesLabel")}>
              {shown.map((tpl) => {
                const on = chosen.includes(tpl.id);
                const full = !on && total >= ENVELOPE_MAX_DOCUMENTS;
                return (
                  <li key={tpl.id}>
                    <label className={cn("flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring", on ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40", full && "cursor-not-allowed opacity-50")}>
                      <input type="checkbox" className="mt-1 size-4" checked={on} disabled={full || busy} onChange={() => toggle(tpl.id)} />
                      <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-foreground">{tpl.name}</span>
                        {tpl.description ? <span className="block truncate text-xs text-muted-foreground">{tpl.description}</span> : null}
                        <span className="block text-xs text-muted-foreground">{tpl.mode === "form" ? tNew("templateFactsForm", { roles: tpl.roles }) : tNew("templateFacts", { pages: tpl.pages, roles: tpl.roles })}</span>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <div className="space-y-1.5 border-t border-border pt-3">
          <p className="text-sm font-medium text-foreground">{t("fileHeading")}</p>
          <p className="text-xs text-muted-foreground">{t("fileHint")}</p>
          <FileDrop file={file} onFile={chooseFile} disabled={busy} />
        </div>
      </section>

      <section aria-labelledby="env-order" className="space-y-2 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="env-order" className="text-sm font-semibold text-foreground">
          {t("orderHeading", { count: total })}
        </h2>
        {total === 0 ? (
          <p className="text-sm text-muted-foreground">{t("nothingChosen")}</p>
        ) : (
          <ol className="space-y-1.5">
            {file ? (
              <li className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                <span className="w-5 text-muted-foreground tabular-nums">1.</span>
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("removeFile")} disabled={busy} onClick={() => chooseFile(null)}>
                  <X aria-hidden />
                </Button>
              </li>
            ) : null}
            {chosen.map((id, i) => {
              const tpl: ActiveTemplate | undefined = byId.get(id);
              const name = tpl?.name ?? id;
              return (
                <li key={id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm">
                  <span className="w-5 text-muted-foreground tabular-nums">{i + 1 + (file ? 1 : 0)}.</span>
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveUp", { title: name })} disabled={busy || i === 0} onClick={() => setChosen((cur) => moved(cur, i, -1))}>
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t("moveDown", { title: name })} disabled={busy || i === chosen.length - 1} onClick={() => setChosen((cur) => moved(cur, i, 1))}>
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t("remove", { title: name })} disabled={busy} onClick={() => toggle(id)}>
                    <X aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ol>
        )}
        <p className={cn("text-xs", ready ? "text-muted-foreground" : "text-amber-700 dark:text-amber-300")} role="status">
          {total < ENVELOPE_MIN_DOCUMENTS ? t("needMore", { min: ENVELOPE_MIN_DOCUMENTS }) : t("count", { count: total, max: ENVELOPE_MAX_DOCUMENTS })}
        </p>
      </section>

      <section aria-labelledby="env-details" className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="env-details" className="text-sm font-semibold text-foreground">
          {tNew("detailsHeading")}
        </h2>
        <div className="space-y-1.5">
          <label htmlFor="env-title" className="text-sm font-medium text-foreground">
            {t("titleLabel")} <span className="font-normal text-muted-foreground">({tNew("optional")})</span>
          </label>
          <Input id="env-title" maxLength={200} value={title} disabled={busy} placeholder={t("titlePlaceholder")} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="env-contact" className="text-sm font-medium text-foreground">
              {tNew("contactLabel")} <span className="font-normal text-muted-foreground">({tNew("optional")})</span>
            </label>
            <ContactPicker
              id="env-contact"
              contactId={contactId}
              onChange={(c) => {
                const next = linksAfterContactChange(links, c?.id ?? null);
                setContactId(next.contactId);
                setTicketId(next.ticketId);
                setDealId(next.dealId);
              }}
              disabled={busy}
            />
          </div>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="env-ticket" className="text-sm font-medium text-foreground">
              {tRec("ticketLabel")} <span className="font-normal text-muted-foreground">({tNew("optional")})</span>
            </label>
            <RecordPicker
              id="env-ticket"
              kind="ticket"
              value={ticketId}
              contactId={contactId}
              disabled={busy}
              onChange={(r) => {
                const next = linksAfterRecord(links, "ticket", r);
                setContactId(next.contactId);
                setTicketId(next.ticketId);
                setDealId(next.dealId);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="env-deal" className="text-sm font-medium text-foreground">
              {tRec("dealLabel")} <span className="font-normal text-muted-foreground">({tNew("optional")})</span>
            </label>
            <RecordPicker
              id="env-deal"
              kind="deal"
              value={dealId}
              contactId={contactId}
              disabled={busy}
              onChange={(r) => {
                const next = linksAfterRecord(links, "deal", r);
                setContactId(next.contactId);
                setTicketId(next.ticketId);
                setDealId(next.dealId);
              }}
            />
          </div>
        </div>
      </section>

      {errorCode ? (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>{tErr(errorKey(errorCode))}</p>
        </div>
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
