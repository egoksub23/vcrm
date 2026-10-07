"use client";

// ============================================================
// Doc Sign, step 1 of the sending workflow before anything exists: upload the documents and title the process. One drop zone takes any number of
// files (up to six) and templates can be ticked beside them; they sit in ONE ordered list that can be reordered and trimmed. One document is sent
// on its own (an ordinary draft); two to six are a document collection. On "Continue" the drafts are made and the sender is taken to the draft's own
// screen, which is the same four steps with this one shown as done.
//
// Nothing is asked here about people, the contact, the ticket or the deal. A contact, ticket or deal named in the address (`?contactId=`,
// `?ticketId=`, `?dealId=`: a contact's page, a ticket, a deal) is kept and the draft is made attached to it.
// ============================================================

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowLeft, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";

import { Input } from "@/components/ui/input";
import { useCapability } from "@/hooks/use-can";
import { useActiveTemplates } from "@/hooks/use-sign-templates";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { collectionRequest, defaultTitle, toggleTemplate, type CollectionItem } from "@/lib/sign/client/collection-list";
import { errorKey } from "@/lib/sign/client/errors";
import { documentLimits, type ProcessSummary as Summary, type StepId } from "@/lib/sign/client/process";
import { isWordFile, uploadDraft, type CreatedDraft } from "@/lib/sign/client/upload";
import { ENVELOPE_MAX_DOCUMENTS } from "@/lib/sign/envelopes";
import { cn } from "@/lib/utils";

import { CollectionList, CollectionPicker } from "../envelope/collection-builder";
import { PrivateToggle } from "./private-toggle";
import { ProcessFooter, ProcessFrame } from "./process-layout";
import { ProcessStepper, type StepAccess } from "./process-stepper";
import { ProcessSummary } from "./process-summary";

interface Props {
  contactId?: string | null;
  ticketId?: string | null;
  dealId?: string | null;
  templateId?: string | null;
  categoryId?: string | null;
}

interface CreatedCollection {
  envelope: { id: string };
}

const BLOCKED: Record<StepId, StepAccess> = {
  documents: { open: true, blockedBy: null },
  people: { open: false, blockedBy: "documents" },
  blocks: { open: false, blockedBy: "documents" },
  send: { open: false, blockedBy: "documents" },
};

export function NewProcess({ contactId = null, ticketId = null, dealId = null, templateId = null, categoryId = null }: Props) {
  const t = useTranslations("Sign.process.new");
  const tn = useTranslations("Sign.send.new");
  const tb = useTranslations("Sign.send.collection.builder");
  const ts = useTranslations("Sign.process.stepper");
  const tw = useTranslations("Sign.process.blockedWhy");
  const tErr = useTranslations("Sign.send");
  const router = useRouter();
  const canSend = useCapability("sign.send");
  const { templates } = useActiveTemplates();

  const [items, setItems] = useState<CollectionItem<File>[]>([]);
  const [title, setTitle] = useState("");
  // migration 176: private to whoever uploads it (the person on this screen), the workspace's admins and the Halo users named as signers
  const [isPrivate, setIsPrivate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);

  // a template named in the address (`?templateId=`) starts in the list, once (as soon as the templates are known)
  const [seeded, setSeeded] = useState(false);
  const wanted = !seeded && templateId ? templates.find((x) => x.id === templateId) : undefined;
  if (wanted) {
    setSeeded(true);
    setItems((cur) => (cur.length === 0 ? toggleTemplate(cur, { id: wanted.id, name: wanted.name }).items : cur));
  }

  const count = items.length;
  const single = count === 1;
  const ready = count >= 1 && count <= ENVELOPE_MAX_DOCUMENTS;
  const kind = single ? "single" : "collection";
  const first = items[0] ? defaultTitle(items[0]) : "";
  const placeholder = count === 0 ? t("titlePlaceholderNone") : single ? first : t("titlePlaceholderCollection", { first, count: count - 1 });

  const change = (next: CollectionItem<File>[]) => {
    setErrorCode(null);
    setNotice(false);
    setItems(next);
  };

  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErrorCode(null);
    setProgress(null);
    try {
      if (single) {
        const only = items[0];
        const name = title.trim() || only.title.trim();
        let created: CreatedDraft;
        if (only.kind === "file") {
          created = await uploadDraft({ file: only.file, title: name, categoryId, contactId, ticketId, dealId, isPrivate, onProgress: setProgress });
        } else {
          created = await signRequest<CreatedDraft>("/api/sign/documents", { json: { templateId: only.id, title: name || undefined, categoryId: categoryId ?? undefined, contactId: contactId ?? undefined, ticketId: ticketId ?? undefined, dealId: dealId ?? undefined, isPrivate: isPrivate || undefined } });
        }
        router.push(`/sign/${created.document.id}`);
      } else {
        const request = collectionRequest(items, { title: title.trim(), contactId, ticketId, dealId, isPrivate: isPrivate ? "true" : null });
        const created = await signRequest<CreatedCollection>("/api/sign/envelopes", request);
        router.push(`/sign/envelopes/${created.envelope.id}`);
      }
    } catch (err) {
      setErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      setBusy(false);
      setProgress(null);
    }
  };

  if (!canSend) {
    return (
      <div className="mx-auto mt-10 max-w-md rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground" role="status">
        <p className="mb-3">{tn("noPermission")}</p>
        <Link href="/sign" className="text-primary underline-offset-4 hover:underline">
          {tn("backToDocuments")}
        </Link>
      </div>
    );
  }

  const uploading = busy && single && items[0]?.kind === "file";
  const percent = progress === null ? 0 : Math.round(progress * 100);
  const anyWord = items.some((i) => i.kind === "file" && isWordFile(i.file.name));
  const limits = documentLimits(kind);

  const summary: Summary = {
    title: title.trim() || (count > 0 ? placeholder : ""),
    documents: items.map((i, n) => ({ id: i.key, title: i.title.trim() || defaultTitle(i) || String(n + 1), pageCount: null, state: "empty", blocks: 0 })),
    people: [],
    left: [
      { id: "documents", done: ready, step: "documents" },
      { id: "signer", done: false, step: "people" },
      { id: "blocks", done: false, step: "blocks" },
      { id: "assign", done: false, step: "blocks" },
      { id: "options", done: false, step: "send" },
    ],
    counts: { signers: 0, copies: 0 },
  };

  return (
    <ProcessFrame
      stepLabel={ts("documents")}
      header={
        <div>
          <Link href="/sign" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" aria-hidden />
            {tn("backToDocuments")}
          </Link>
          <h1 className="mt-1 text-xl font-semibold text-foreground">{tn("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
      }
      stepper={<ProcessStepper current="documents" status={null} access={BLOCKED} onGo={(s) => setNotice(s !== "documents")} />}
      notice={
        notice ? (
          <p role="status" data-blocked-notice className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-foreground">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-[light-dark(#92400e,#fcd34d)]" aria-hidden />
            <span>{t("blockedNotice", { step: ts("documents"), why: tw("no_documents", { count: 0 }) })}</span>
          </p>
        ) : null
      }
      summary={<ProcessSummary summary={summary} kind={kind} onGo={() => setNotice(true)} />}
      footer={
        <ProcessFooter
          step="documents"
          nextName={ts("people")}
          busy={busy}
          blockedText={ready ? null : tw("no_documents", { count: 0 })}
          onBack={() => router.push("/sign")}
          onContinue={() => void create()}
        />
      }
    >
      <div className="space-y-4" data-step-body="documents" data-new>
        <div>
          <h2 className="text-base font-semibold text-foreground">{ts("documents")}</h2>
          <p className="text-sm text-muted-foreground">{t("intro", { max: ENVELOPE_MAX_DOCUMENTS })}</p>
        </div>

        <section aria-labelledby="new-choose" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
          <h3 id="new-choose" className="text-sm font-semibold text-foreground">
            {tb("chooseHeading")}
          </h3>
          <CollectionPicker items={items} onItems={change} max={ENVELOPE_MAX_DOCUMENTS} disabled={busy} />
          {anyWord ? <p className="text-xs text-muted-foreground">{tn("wordNote")}</p> : null}
        </section>

        <section aria-labelledby="new-list" className="space-y-2 rounded-xl border border-border bg-card p-4 sm:p-5">
          <h3 id="new-list" className="text-sm font-semibold text-foreground">
            {tb("orderHeading", { count, max: ENVELOPE_MAX_DOCUMENTS })}
          </h3>
          {count === 0 ? (
            <p className="text-sm text-muted-foreground">{tb("nothingChosen")}</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{single ? t("hintSingle") : tb("orderHint")}</p>
              <CollectionList items={items} onItems={change} disabled={busy} />
            </>
          )}
          <p className={cn("text-xs", ready ? "text-muted-foreground" : "text-[light-dark(#92400e,#fcd34d)]")} role="status">
            {count === 0 ? t("countNone") : single ? t("countSingle") : count >= limits.max ? tb("full", { max: ENVELOPE_MAX_DOCUMENTS }) : t("countCollection", { count, max: ENVELOPE_MAX_DOCUMENTS })}
          </p>
        </section>

        <section className="space-y-1.5 rounded-xl border border-border bg-card p-4 sm:p-5">
          <label htmlFor="new-title" className="text-sm font-medium text-foreground">
            {single || count === 0 ? tn("titleLabel") : tb("titleLabel")} <span className="font-normal text-muted-foreground">({tn("optional")})</span>
          </label>
          <Input id="new-title" maxLength={200} value={title} disabled={busy} placeholder={placeholder} onChange={(e) => setTitle(e.target.value)} />
          <p className="text-xs text-muted-foreground">{t("titleHint")}</p>
        </section>

        <PrivateToggle id="new-private" checked={isPrivate} collection={count > 1} disabled={busy} onChange={setIsPrivate} />

        {errorCode ? (
          <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>{tErr(errorKey(errorCode))}</p>
          </div>
        ) : null}

        {uploading ? (
          <div className="space-y-1.5" role="status" aria-live="polite">
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={tn("uploading")}>
              <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
            </div>
            <p className="text-xs text-muted-foreground">{percent >= 100 ? tn("preparing") : tn("uploadingPercent", { percent })}</p>
          </div>
        ) : busy ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground" role="status" aria-live="polite">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            {tb("creating")}
          </p>
        ) : null}
      </div>
    </ProcessFrame>
  );
}
