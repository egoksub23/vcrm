"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { DocumentDetail } from "@/components/sign/detail/document-detail";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { SingleProcess } from "../process/single-process";

interface Slot {
  id: string;
  status: string | null;
  failed: boolean;
}

/**
 * One document: its page is the sending workflow (the four steps) while it is a draft and the document detail from the
 * moment it is sent. The status is read through row level security; a document that is not there (or not
 * this workspace's) reads as not found.
 */
export function SignDocumentView({ documentId, asked }: { documentId: string; asked?: { step?: string | null; doc?: string | null } }) {
  const t = useTranslations("Sign.send.view");
  const { accountId } = useAuth();
  const [slot, setSlot] = useState<Slot | null>(null);
  const [tick, setTick] = useState(0);
  // after "Send" the workspace shows who was invited; this switches to the document once the sender asks to
  const [openedDetail, setOpenedDetail] = useState(false);

  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      const { data, error } = await createClient().from("sign_documents").select("status").eq("id", documentId).maybeSingle();
      if (cancelled) return;
      if (error) console.error("[SignDocumentView] fetch error:", error);
      setSlot({ id: documentId, status: (data as { status: string } | null)?.status ?? null, failed: !!error });
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, documentId, tick]);

  const current = slot && slot.id === documentId ? slot : null;

  if (!current) {
    return (
      <div className="flex items-center justify-center py-24" role="status" aria-label={t("loading")}>
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (current.failed || current.status === null) {
    return (
      <div role="alert" className="mx-auto mt-10 flex max-w-md flex-col items-center gap-3 rounded-xl border border-border bg-card p-8 text-center">
        <AlertCircle className="size-6 text-muted-foreground" aria-hidden />
        <h1 className="text-base font-semibold text-foreground">{current.failed ? t("failedTitle") : t("notFoundTitle")}</h1>
        <p className="text-sm text-muted-foreground">{current.failed ? t("failedBody") : t("notFoundBody")}</p>
        <div className="flex gap-2">
          {current.failed ? (
            <Button type="button" variant="outline" size="sm" onClick={() => setTick((n) => n + 1)}>
              {t("retry")}
            </Button>
          ) : null}
          <Link href="/sign" className="inline-flex h-7 items-center rounded-lg px-2.5 text-[0.8rem] font-medium text-primary hover:underline">
            {t("backToDocuments")}
          </Link>
        </div>
      </div>
    );
  }

  if (current.status === "draft" && !openedDetail) {
    return <SingleProcess documentId={documentId} asked={asked} onOpenDocument={() => setOpenedDetail(true)} />;
  }

  return (
    <div className="mx-auto max-w-[1200px]">
      <DocumentDetail documentId={documentId} />
    </div>
  );
}
