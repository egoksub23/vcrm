"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle, ArrowLeft, FileText, Files, Loader2, Upload } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useCapability } from "@/hooks/use-can";
import { useSignCategories } from "@/hooks/use-sign-categories";
import { useActiveTemplates } from "@/hooks/use-sign-templates";
import { SignApiError, signRequest } from "@/lib/sign/client/api";
import { errorKey } from "@/lib/sign/client/errors";
import { checkUploadFile, isWordFile, titleFromFileName, uploadDraft, type CreatedDraft } from "@/lib/sign/client/upload";
import { cn } from "@/lib/utils";
import { linksAfterContactChange, linksAfterRecord } from "@/lib/sign/client/record-links";
import { NewEnvelope } from "../envelope/new-envelope";
import { ContactPicker } from "./contact-picker";
import { FileDrop } from "./file-drop";
import { RecordPicker } from "./record-picker";
import { TemplatePicker } from "./template-picker";

type Mode = "upload" | "template";
/** What the process is: one document, or a collection of two to six signed in one sitting. The first choice on the page. */
type Kind = "single" | "collection";

interface Props {
  contactId?: string | null;
  /** F-51: opened from a ticket or a deal, so the document is attached to it. */
  ticketId?: string | null;
  dealId?: string | null;
  templateId?: string | null;
  categoryId?: string | null;
  /** Open with the document collection chosen (`?kind=collection`). */
  kind?: Kind | null;
}

/**
 * Start a document: from a file (PDF, Word or image) or from an active template, with an optional category,
 * contact and title. Creates the draft and goes to it.
 */
export function NewDocument({ contactId: initialContact = null, ticketId: initialTicket = null, dealId: initialDeal = null, templateId: initialTemplate = null, categoryId: initialCategory = null, kind: initialKind = null }: Props) {
  const t = useTranslations("Sign.send.new");
  const tErr = useTranslations("Sign.send");
  const tRec = useTranslations("Sign.send.records");
  const tKind = useTranslations("Sign.send.collection.choice");
  const router = useRouter();
  const canSend = useCapability("sign.send");
  const { live } = useSignCategories();
  const { templates, loading: templatesLoading, error: templatesError } = useActiveTemplates();

  const [kind, setKind] = useState<Kind>(initialKind ?? "single");
  const [mode, setMode] = useState<Mode>(initialTemplate ? "template" : "upload");
  const [file, setFile] = useState<File | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(initialTemplate);
  const template = templates.find((x) => x.id === templateId) ?? null;
  const [title, setTitle] = useState("");
  // undefined: not chosen yet (a template's own category applies); null: none
  const [chosenCategory, setChosenCategory] = useState<string | null | undefined>(initialCategory ?? undefined);
  const [contactId, setContactId] = useState<string | null>(initialContact);
  const [ticketId, setTicketId] = useState<string | null>(initialTicket);
  const [dealId, setDealId] = useState<string | null>(initialDeal);
  const links = { contactId, ticketId, dealId };
  const setLinks = (next: { contactId: string | null; ticketId: string | null; dealId: string | null }) => {
    setContactId(next.contactId);
    setTicketId(next.ticketId);
    setDealId(next.dealId);
  };
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  const categoryValue = chosenCategory === undefined ? (mode === "template" ? (template?.category_id ?? "") : "") : (chosenCategory ?? "");

  const chooseFile = (f: File | null) => {
    setErrorCode(null);
    if (f) {
      const problem = checkUploadFile(f);
      if (problem) {
        setFile(null);
        setErrorCode(problem);
        return;
      }
    }
    setFile(f);
  };

  const ready = mode === "upload" ? !!file : !!template;

  const create = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErrorCode(null);
    setProgress(null);
    try {
      let created: CreatedDraft;
      if (mode === "upload" && file) {
        created = await uploadDraft({ file, title, categoryId: chosenCategory ?? null, contactId, ticketId, dealId, onProgress: setProgress });
      } else {
        created = await signRequest<CreatedDraft>("/api/sign/documents", {
          json: { templateId: template?.id, title: title.trim() || undefined, categoryId: chosenCategory ?? undefined, contactId: contactId ?? undefined, ticketId: ticketId ?? undefined, dealId: dealId ?? undefined },
        });
      }
      router.push(`/sign/${created.document.id}`);
    } catch (err) {
      setErrorCode(err instanceof SignApiError ? err.code : "request_failed");
      setBusy(false);
      setProgress(null);
    }
  };

  if (!canSend) {
    return (
      <div className="mx-auto mt-10 max-w-md rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground" role="status">
        <p className="mb-3">{t("noPermission")}</p>
        <Link href="/sign" className="text-primary underline-offset-4 hover:underline">
          {t("backToDocuments")}
        </Link>
      </div>
    );
  }

  const uploading = busy && mode === "upload";
  const percent = progress === null ? 0 : Math.round(progress * 100);

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div>
        <Link href="/sign" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" aria-hidden />
          {t("backToDocuments")}
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-foreground">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      {/* the first choice: one document, or a collection of several signed in one sitting (migration 171). The contact, ticket and deal are kept when it changes. */}
      <section aria-labelledby="new-kind" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
        <h2 id="new-kind" className="text-sm font-semibold text-foreground">
          {tKind("heading")}
        </h2>
        <div role="radiogroup" aria-labelledby="new-kind" className="grid gap-2 sm:grid-cols-2">
          {(
            [
              { id: "single", icon: FileText, label: tKind("single"), hint: tKind("singleHint") },
              { id: "collection", icon: Files, label: tKind("collection"), hint: tKind("collectionHint") },
            ] as const
          ).map((k) => (
            <label
              key={k.id}
              className={cn(
                "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                kind === k.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
                busy && "pointer-events-none opacity-60",
              )}
            >
              <input type="radio" name="kind" className="sr-only" checked={kind === k.id} onChange={() => setKind(k.id)} disabled={busy} />
              <k.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span>
                <span className="block text-sm font-medium text-foreground">{k.label}</span>
                <span className="block text-xs text-muted-foreground">{k.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {kind === "collection" ? <NewEnvelope embedded links={links} onLinks={setLinks} /> : null}

      {kind === "single" ? (
        <>
          <section aria-labelledby="new-start" className="space-y-3 rounded-xl border border-border bg-card p-4 sm:p-5">
            <h2 id="new-start" className="text-sm font-semibold text-foreground">
              {t("startHeading")}
            </h2>
            <div role="radiogroup" aria-labelledby="new-start" className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  { id: "upload", icon: Upload, label: t("modeUpload"), hint: t("modeUploadHint") },
                  { id: "template", icon: FileText, label: t("modeTemplate"), hint: t("modeTemplateHint") },
                ] as const
              ).map((m) => (
                <label
                  key={m.id}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                    mode === m.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40",
                    busy && "pointer-events-none opacity-60",
                  )}
                >
                  <input type="radio" name="mode" className="sr-only" checked={mode === m.id} onChange={() => setMode(m.id)} disabled={busy} />
                  <m.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span>
                    <span className="block text-sm font-medium text-foreground">{m.label}</span>
                    <span className="block text-xs text-muted-foreground">{m.hint}</span>
                  </span>
                </label>
              ))}
            </div>

            {mode === "upload" ? (
              <FileDrop file={file} onFile={chooseFile} disabled={busy} />
            ) : (
              <TemplatePicker templates={templates} loading={templatesLoading} error={templatesError} selectedId={template?.id ?? null} onSelect={(tpl) => setTemplateId(tpl.id)} />
            )}
            {mode === "upload" && file && isWordFile(file.name) ? <p className="text-xs text-muted-foreground">{t("wordNote")}</p> : null}
          </section>

          <section aria-labelledby="new-details" className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
            <h2 id="new-details" className="text-sm font-semibold text-foreground">
              {t("detailsHeading")}
            </h2>
            <div className="space-y-1.5">
              <label htmlFor="new-title" className="text-sm font-medium text-foreground">
                {t("titleLabel")} <span className="font-normal text-muted-foreground">({t("optional")})</span>
              </label>
              <Input
                id="new-title"
                maxLength={200}
                value={title}
                disabled={busy}
                placeholder={mode === "upload" ? (file ? titleFromFileName(file.name) : t("titlePlaceholderFile")) : (template?.name ?? t("titlePlaceholderTemplate"))}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="new-category" className="text-sm font-medium text-foreground">
                  {t("categoryLabel")} <span className="font-normal text-muted-foreground">({t("optional")})</span>
                </label>
                <select
                  id="new-category"
                  value={categoryValue}
                  disabled={busy}
                  onChange={(e) => setChosenCategory(e.target.value === "" ? null : e.target.value)}
                  className="h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <option value="">{t("noCategory")}</option>
                  {live.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="new-contact" className="text-sm font-medium text-foreground">
                  {t("contactLabel")} <span className="font-normal text-muted-foreground">({t("optional")})</span>
                </label>
                <ContactPicker id="new-contact" contactId={contactId} onChange={(c) => setLinks(linksAfterContactChange(links, c?.id ?? null))} disabled={busy} />
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="new-ticket" className="text-sm font-medium text-foreground">
                  {tRec("ticketLabel")} <span className="font-normal text-muted-foreground">({t("optional")})</span>
                </label>
                <RecordPicker id="new-ticket" kind="ticket" value={ticketId} contactId={contactId} disabled={busy} onChange={(r) => setLinks(linksAfterRecord(links, "ticket", r))} />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="new-deal" className="text-sm font-medium text-foreground">
                  {tRec("dealLabel")} <span className="font-normal text-muted-foreground">({t("optional")})</span>
                </label>
                <RecordPicker id="new-deal" kind="deal" value={dealId} contactId={contactId} disabled={busy} onChange={(r) => setLinks(linksAfterRecord(links, "deal", r))} />
              </div>
            </div>
          </section>

          {errorCode ? (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
              <p>{tErr(errorKey(errorCode))}</p>
            </div>
          ) : null}

          {uploading ? (
            <div className="space-y-1.5" role="status" aria-live="polite">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label={t("uploading")}>
                <div className="h-full bg-primary transition-[width]" style={{ width: `${percent}%` }} />
              </div>
              <p className="text-xs text-muted-foreground">{percent >= 100 ? t("preparing") : t("uploadingPercent", { percent })}</p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Link href="/sign" className="inline-flex h-9 items-center rounded-lg px-3 text-sm text-muted-foreground hover:text-foreground">
              {t("cancel")}
            </Link>
            <Button type="button" size="lg" disabled={!ready || busy} onClick={() => void create()}>
              {busy ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t("createDraft")}
            </Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
