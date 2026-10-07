"use client";

// ============================================================
// Doc Sign, a document on its own that is still a draft: loads it and hands the sending workflow (`ProcessShell`) the routes of a document. The
// workflow is the same four steps as a collection's; this is only what is read and where it is saved. A document of a collection is not shown here
// (its workflow is the collection's): it goes to its collection, at the signature blocks, on the document.
// ============================================================

import { useEffect, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { useSignDraft, type DraftData } from "@/hooks/use-sign-draft";
import { signRequest } from "@/lib/sign/client/api";
import { isEmptyPatch, optionsFromDocument, optionsPatch } from "@/lib/sign/client/draft-options";
import { errorKey } from "@/lib/sign/client/errors";
import { sourceFromDraft } from "@/lib/sign/client/process";
import type { SignCopyRecipientRow, SignDocumentRow } from "@/lib/sign/types";

import type { SendResultData } from "../send/send-result";
import { ProcessShell } from "./process-shell";
import type { ProcessApi } from "./use-process";

interface Props {
  documentId: string;
  /** Called when the sender asks to see the document (after sending it, or when it turns out it was sent already). */
  onOpenDocument: () => void;
  asked?: { step?: string | null; doc?: string | null };
}

/** The draft as the route answers it: `copies` are the people who receive the signed copy (a document on its own only; migration 175). */
type DraftWithCopies = DraftData & { copies?: SignCopyRecipientRow[] };

export function SingleProcess({ documentId, onOpenDocument, asked }: Props) {
  const t = useTranslations("Sign.send.workspace");
  const tErr = useTranslations("Sign.send");
  const router = useRouter();
  const { data, error, loading, reload, retry, setDocument } = useSignDraft(documentId);
  const envelopeId = data?.document.envelope_id ?? null;

  // a document of a collection: its workflow is the collection's, at the signature blocks, on this document
  useEffect(() => {
    if (envelopeId) router.replace(`/sign/envelopes/${envelopeId}?step=blocks&doc=${documentId}`);
  }, [envelopeId, documentId, router]);

  const source = useMemo(() => (data && !envelopeId ? sourceFromDraft(data as DraftWithCopies) : null), [data, envelopeId]);
  const api = useMemo<ProcessApi>(
    () => ({
      savePeople: async (payload, ordered) => {
        await signRequest(`/api/sign/documents/${documentId}/signers`, { method: "PUT", json: { people: payload, ordered } });
      },
      saveOptions: async (saved, typed) => {
        const patch = optionsPatch(saved, typed, new Date());
        if (isEmptyPatch(patch)) return null;
        const res = await signRequest<{ document: SignDocumentRow }>(`/api/sign/documents/${documentId}`, { method: "PATCH", json: patch });
        setDocument(res.document);
        return optionsFromDocument(res.document);
      },
      send: async () => {
        const r = await signRequest<SendResultData>(`/api/sign/documents/${documentId}/send`, { method: "POST" });
        return { reference: r.reference, expiresAt: r.expiresAt, invited: r.invited, documents: 1 };
      },
      remove: async () => {
        await signRequest(`/api/sign/documents/${documentId}`, { method: "DELETE" });
      },
      reload: async () => {
        const fresh = await reload();
        return fresh ? sourceFromDraft(fresh as DraftWithCopies) : null;
      },
    }),
    [documentId, reload, setDocument],
  );

  if (loading || envelopeId) {
    return (
      <div className="flex items-center justify-center py-24" role="status" aria-label={t("loading")}>
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }
  if (error || !data || !source) {
    return (
      <div role="alert" className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-card p-8 text-center">
        <AlertCircle className="size-6 text-muted-foreground" aria-hidden />
        <p className="text-sm text-foreground">{tErr(errorKey(error?.code))}</p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={retry}>
            {t("retry")}
          </Button>
          <Link href="/sign" className="inline-flex h-7 items-center rounded-lg px-2.5 text-[0.8rem] font-medium text-primary hover:underline">
            {t("backToDocuments")}
          </Link>
        </div>
      </div>
    );
  }
  if (data.document.status !== "draft") {
    return (
      <div className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-card p-8 text-center" role="status">
        <p className="text-sm text-foreground">{t("alreadySent")}</p>
        <Button type="button" onClick={onOpenDocument}>
          {t("openDocument")}
        </Button>
      </div>
    );
  }
  return <ProcessShell key={documentId} source={source} api={api} asked={asked} onOpen={onOpenDocument} />;
}
