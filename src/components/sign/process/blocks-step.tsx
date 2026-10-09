"use client";

// ============================================================
// Secure Sign, step 3 of the sending workflow: the signature blocks. ONE editor for a document on its own and for a document collection (a single
// document is a collection of one): every page of every document in one continuous scroll, the people and the field types on the left, the
// documents and their pages on the right (src/components/sign/blocks/). The sender never opens the documents one by one.
//
// A document with a form (a template with parts) shows its form summary in its own header and joins the scroll when it has pages; a form with
// nothing printed is a card in the sequence. The people are step 2's, so they are known here.
// ============================================================

import { useTranslations } from "next-intl";

import { BlocksEditor } from "@/components/sign/blocks/blocks-editor";

import type { Process } from "./use-process";

export function BlocksStep({ process }: { process: Process }) {
  const t = useTranslations("Sign.process.blocks");
  const tm = useTranslations("Sign.process.multi");
  const single = process.kind === "single";

  return (
    <div className="space-y-4" data-step-body="blocks">
      <div>
        <h2 className="text-base font-semibold text-foreground">{process.formOnly ? t("headingForm") : t("heading")}</h2>
        <p className="text-sm text-muted-foreground">{single ? t("introSingle") : tm("introCollection")}</p>
      </div>

      <BlocksEditor process={process} />

      {!process.canSend ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("readOnly")}
        </p>
      ) : null}
    </div>
  );
}
