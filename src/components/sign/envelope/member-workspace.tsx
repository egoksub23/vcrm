"use client";

// ============================================================
// Doc Sign, one DRAFT document of an envelope (migration 171). Its fields, its values to fill in and its form are prepared here exactly as for a
// document alone (the same editors); what the envelope shares (the people, the options, the review and Send) is on the envelope, so this screen
// says so and takes the sender back to it.
// ============================================================

import Link from "next/link";
import { ArrowLeft, Layers } from "lucide-react";
import { useTranslations } from "next-intl";

import { DraftFieldsEditor } from "@/components/sign/editor/draft-fields-editor";
import { useCapability } from "@/hooks/use-can";
import type { DraftData } from "@/hooks/use-sign-draft";
import { hasFormParts } from "@/lib/sign/client/progress-logic";
import { isFormMode } from "@/lib/sign/types";

import { FormFieldsStep } from "../send/form-fields-step";
import { DocumentStatusBadge } from "../send/status-badge";

interface Props {
  documentId: string;
  data: DraftData;
  reload: () => Promise<DraftData | null>;
}

export function EnvelopeMemberWorkspace({ documentId, data, reload }: Props) {
  const t = useTranslations("Sign.send.envelope.member");
  const canSend = useCapability("sign.send");
  const doc = data.document;
  const envelope = data.envelope;
  const form = hasFormParts(doc.form_snapshot) ? doc.form_snapshot : null;
  const place = envelope?.documents.find((d) => d.id === documentId)?.position ?? doc.envelope_position ?? 1;

  return (
    <div className="mx-auto max-w-[1400px] space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/sign/envelopes/${doc.envelope_id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3.5" aria-hidden />
            {t("backToEnvelope")}
          </Link>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <h1 className="truncate text-xl font-semibold text-foreground">{doc.title}</h1>
            <DocumentStatusBadge status="draft" />
            {doc.reference ? <span className="text-xs text-muted-foreground">{doc.reference}</span> : null}
          </div>
        </div>
      </div>

      <div role="status" className="flex items-start gap-2 rounded-xl border border-primary/30 bg-primary/5 p-3 text-sm">
        <Layers className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
        <p className="text-foreground">
          {t("banner", { title: envelope?.title ?? "", number: place, count: envelope?.documents.length ?? 0 })}{" "}
          <Link href={`/sign/envelopes/${doc.envelope_id}`} className="font-medium text-primary underline-offset-4 hover:underline">
            {t("openEnvelope")}
          </Link>
        </p>
      </div>

      {form ? <FormFieldsStep documentId={documentId} form={form} roles={doc.roles_snapshot} readOnly={!canSend} onChanged={() => void reload()} formOnly={isFormMode(doc)} /> : <DraftFieldsEditor documentId={documentId} onChanged={() => void reload()} />}
    </div>
  );
}
