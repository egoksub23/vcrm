"use client";

// Doc Sign, the detail screen: the top of the page. The title, reference and status, what the document is
// about (category, contact, ticket, deal), its dates in the viewer's time zone, and the actions that fit its state.

import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { ChevronRight, Download, Eye, FileDown, Loader2, Ban } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { documentBadgeClass, documentStatusKey, SIGN_STATUS_NAMESPACE } from "@/lib/sign/client/status";
import type { SignDocumentRow } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

import { formatWhen } from "./format";
import type { DocumentActions } from "./logic";
import type { DocumentLinks } from "./use-document-links";

export type DownloadKind = "final" | "original";

interface Props {
  document: SignDocumentRow;
  links: DocumentLinks;
  actions: DocumentActions;
  downloading: DownloadKind | null;
  onView: () => void;
  onDownload: (kind: DownloadKind) => void;
  onVoid: () => void;
  /** F-95: the sender's switch for forwarding, while the document is open (absent when it cannot change). */
  forwarding?: { allowed: boolean; busy: boolean; onChange: (allow: boolean) => void };
}

export function DetailHeader({ document: doc, links, actions, downloading, onView, onDownload, onVoid, forwarding }: Props) {
  const t = useTranslations("Sign.detail");
  const ts = useTranslations(SIGN_STATUS_NAMESPACE);
  const locale = useLocale();

  return (
    <header className="grid gap-4">
      <nav aria-label={t("header.breadcrumb")} className="flex items-center gap-1 text-sm text-muted-foreground">
        <Link href="/sign" className="rounded-sm hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none">
          {t("header.back")}
        </Link>
        <ChevronRight className="size-3.5" aria-hidden />
        <span className="truncate" aria-current="page">
          {doc.reference ?? doc.title}
        </span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="min-w-0 break-words text-2xl font-bold text-foreground">{doc.title}</h1>
            <span className={cn("inline-flex h-6 items-center rounded-full px-2.5 text-xs font-medium", documentBadgeClass(doc.status))}>{ts(documentStatusKey(doc.status))}</span>
            {doc.test && <span className="inline-flex h-6 items-center rounded-full bg-red-100 px-2.5 text-xs font-bold tracking-wide text-red-700 uppercase dark:bg-red-950 dark:text-red-300">{t("header.testChip")}</span>}
            {doc.mode === "form" && <span className="inline-flex h-6 items-center rounded-full border border-border px-2.5 text-xs text-muted-foreground">{t("header.formChip")}</span>}
            {doc.sign_in_order && <span className="inline-flex h-6 items-center rounded-full border border-border px-2.5 text-xs text-muted-foreground">{t(doc.mode === "form" ? "header.inOrderForm" : "header.inOrder")}</span>}
            {doc.code_required && <span className="inline-flex h-6 items-center rounded-full border border-border px-2.5 text-xs text-muted-foreground">{t("header.codeRequired")}</span>}
          </div>
          {doc.reference && <p className="mt-1 text-sm text-muted-foreground">{t("header.reference", { reference: doc.reference })}</p>}
          {doc.test && <p className="mt-1 max-w-[70ch] text-sm text-red-700 dark:text-red-300">{t("header.testNote")}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {actions.downloadSigned && (
            <Button onClick={() => onDownload("final")} disabled={downloading !== null}>
              {downloading === "final" ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
              {t(doc.mode === "form" ? "actions.downloadRecord" : "actions.downloadSigned")}
            </Button>
          )}
          {actions.viewKind && (
            <Button variant="outline" onClick={onView}>
              <Eye aria-hidden />
              {t("actions.view")}
            </Button>
          )}
          {actions.downloadOriginal && (
            <Button variant="outline" onClick={() => onDownload("original")} disabled={downloading !== null}>
              {downloading === "original" ? <Loader2 className="animate-spin" aria-hidden /> : <FileDown aria-hidden />}
              {t("actions.downloadOriginal")}
            </Button>
          )}
          {actions.void && (
            <Button variant="destructive" onClick={onVoid}>
              <Ban aria-hidden />
              {t("actions.void")}
            </Button>
          )}
        </div>
      </div>

      {forwarding && (
        <label className="flex w-fit cursor-pointer items-start gap-2.5 text-sm">
          <Checkbox className="mt-0.5" checked={forwarding.allowed} disabled={forwarding.busy} onCheckedChange={(c) => forwarding.onChange(c === true)} />
          <span>
            <span className="block font-medium text-foreground">{t("forwarding.label")}</span>
            <span className="block text-xs text-muted-foreground">{t(forwarding.allowed ? "forwarding.onHint" : "forwarding.offHint")}</span>
          </span>
        </label>
      )}

      <dl className="grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
        {links.category && <Meta label={t("meta.category")}>{links.category}</Meta>}
        {links.contact && (
          <Meta label={t("meta.contact")}>
            <Link href={`/contacts?contact=${links.contact.id}`} className="text-primary hover:underline">
              {links.contact.label || t("meta.contactUnnamed")}
            </Link>
          </Meta>
        )}
        {links.ticket && (
          <Meta label={t("meta.ticket")}>
            <Link href={`/tickets/${links.ticket.id}`} className="text-primary hover:underline">
              #{links.ticket.number} {links.ticket.subject}
            </Link>
          </Meta>
        )}
        {links.deal && (
          <Meta label={t("meta.deal")}>
            <Link href={`/pipelines?deal=${links.deal.id}`} className="text-primary hover:underline">
              {links.deal.title}
            </Link>
          </Meta>
        )}
        <Meta label={t("meta.created")}>{formatWhen(doc.created_at, locale)}</Meta>
        {doc.sent_at && <Meta label={t("meta.sent")}>{formatWhen(doc.sent_at, locale)}</Meta>}
        {doc.completed_at && <Meta label={t("meta.completed")}>{formatWhen(doc.completed_at, locale)}</Meta>}
        {doc.expires_at && <Meta label={t(doc.status === "expired" ? "meta.expired" : "meta.expires")}>{formatWhen(doc.expires_at, locale)}</Meta>}
      </dl>
    </header>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-foreground">{children}</dd>
    </div>
  );
}
