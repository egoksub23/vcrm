"use client";

// ============================================================
// Doc Sign: the detail of a document that was sent (`/sign/<id>` when the status is not draft).
//
// What is happening to it (a banner), who has signed and who has not (with Remind, Resend and Change recipient),
// the document itself, and its history. The page reads the document through the route, reads it again after every
// action, and checks again every ten seconds while someone may still sign (paused while the tab is hidden).
// ============================================================

import { useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useCapability } from "@/hooks/use-can";
import { documentFileUrl, SignApiError } from "@/lib/sign/client/api";
import { hasFormParts } from "@/lib/sign/client/progress-logic";

import { DetailHeader, type DownloadKind } from "./detail-header";
import { DocumentViewer } from "./document-viewer";
import { downloadFile } from "./download";
import { FilesList } from "./files-list";
import { HistoryView } from "./history-view";
import { bannerFor, detailErrorKey, documentActions, signersWithUndelivered, type DetailCaps } from "./logic";
import { PeopleList } from "./people-list";
import { ProgressTab } from "./progress/progress-tab";
import { StatusBanner } from "./status-banner";
import { useDocumentDetail } from "./use-document-detail";
import { useDocumentEvents } from "./use-document-events";
import { useDocumentLinks } from "./use-document-links";
import { VoidDialog } from "./void-dialog";

type TabKey = "people" | "progress" | "document" | "history";

export function DocumentDetail({ documentId }: { documentId: string }) {
  const t = useTranslations("Sign.detail");
  const tp = useTranslations("Sign.progress");
  const canSend = useCapability("sign.send");
  const canVoid = useCapability("sign.void");
  const canSettings = useCapability("sign.settings");
  const caps: DetailCaps = { send: canSend, void: canVoid, settings: canSettings };

  const { data, error, loading, version, reload } = useDocumentDetail(documentId);
  const events = useDocumentEvents(documentId, version);
  const doc = data?.document ?? null;
  const links = useDocumentLinks(doc ? { categoryId: doc.category_id, contactId: doc.contact_id, ticketId: doc.ticket_id, dealId: doc.deal_id } : null);

  // A document with a form opens on its progress; a choice the reader makes is kept.
  const [chosenTab, setTab] = useState<TabKey | null>(null);
  const [viewChoice, setViewChoice] = useState<"final" | "base" | null>(null);
  const [downloading, setDownloading] = useState<DownloadKind | null>(null);
  const [voiding, setVoiding] = useState(false);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center" role="status" aria-label={t("loading")}>
        <Loader2 className="size-6 animate-spin text-primary" aria-hidden />
      </div>
    );
  }

  if (error || !data || !doc) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-center" role="alert">
        <p className="text-sm text-foreground">{t(detailErrorKey(error?.code === "document_not_found" ? "document_not_found" : error?.code))}</p>
        {error?.code !== "document_not_found" && (
          <Button variant="outline" onClick={() => void reload()}>
            {t("retry")}
          </Button>
        )}
      </div>
    );
  }

  const withForm = hasFormParts(doc.form_snapshot);
  const tab: TabKey = chosenTab === "progress" && !withForm ? "people" : (chosenTab ?? (withForm ? "progress" : "people"));
  const actions = documentActions(doc, caps);
  const banner = bannerFor(doc, data.signers, caps);
  const undelivered = signersWithUndelivered(events.events ?? []);
  const viewKind = viewChoice && viewChoice === "base" && doc.base_path ? "base" : viewChoice === "final" && actions.downloadSigned ? "final" : actions.viewKind;

  async function download(kind: DownloadKind) {
    setDownloading(kind);
    try {
      await downloadFile(documentFileUrl(documentId, kind, true), kind === "final" ? `${doc?.reference ?? "document"}-signed.pdf` : `${doc?.reference ?? "document"}-original`);
    } catch (err) {
      toast.error(t(detailErrorKey(err instanceof SignApiError ? err.code : "request_failed")));
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="grid gap-6">
      <DetailHeader
        document={doc}
        links={links}
        actions={actions}
        downloading={downloading}
        onView={() => setTab("document")}
        onDownload={(k) => void download(k)}
        onVoid={() => setVoiding(true)}
      />

      <StatusBanner banner={banner} />

      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList variant="line" className="w-full justify-start border-b border-border">
          {withForm && (
            <TabsTrigger value="progress" className="flex-none px-3">
              {tp("tabs.progress")}
            </TabsTrigger>
          )}
          <TabsTrigger value="people" className="flex-none px-3">
            {t("tabs.people", { count: data.signers.length })}
          </TabsTrigger>
          <TabsTrigger value="document" className="flex-none px-3" disabled={!actions.viewKind}>
            {t("tabs.document")}
          </TabsTrigger>
          <TabsTrigger value="history" className="flex-none px-3">
            {t("tabs.history")}
          </TabsTrigger>
        </TabsList>

        {withForm && (
          <TabsContent value="progress" className="pt-4">
            <ProgressTab document={doc} signers={data.signers} events={events.events} caps={caps} active={tab === "progress"} onDocumentChanged={reload} />
          </TabsContent>
        )}

        <TabsContent value="people" className="grid gap-6 pt-4">
          <PeopleList document={doc} signers={data.signers} undelivered={undelivered} caps={caps} onChanged={reload} />
          <FilesList files={data.files} />
        </TabsContent>

        <TabsContent value="document" className="grid gap-3 pt-4">
          {viewKind && (
            <>
              {actions.downloadSigned && doc.base_path && (
                <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label={t("viewer.which")}>
                  <Button size="sm" variant={viewKind === "final" ? "default" : "outline"} aria-pressed={viewKind === "final"} onClick={() => setViewChoice("final")}>
                    {t("viewer.signedCopy")}
                  </Button>
                  <Button size="sm" variant={viewKind === "base" ? "default" : "outline"} aria-pressed={viewKind === "base"} onClick={() => setViewChoice("base")}>
                    {t("viewer.asSent")}
                  </Button>
                </div>
              )}
              <p className="text-xs text-muted-foreground">{t(viewKind === "final" ? "viewer.noteSigned" : "viewer.noteSent")}</p>
              <DocumentViewer documentId={documentId} kind={viewKind} version={`${viewKind}|${viewKind === "final" ? doc.final_path : doc.base_path}`} />
            </>
          )}
        </TabsContent>

        <TabsContent value="history" className="pt-4">
          <HistoryView events={events.events} chain={events.chain} loading={events.loading} failed={events.failed} signers={data.signers} signInOrder={doc.sign_in_order} technical={canSettings} form={doc.form_snapshot} contactId={doc.contact_id} />
        </TabsContent>
      </Tabs>

      {voiding && <VoidDialog documentId={documentId} title={doc.title} onClose={() => setVoiding(false)} onVoided={reload} />}
    </div>
  );
}
