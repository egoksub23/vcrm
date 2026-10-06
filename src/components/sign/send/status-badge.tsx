"use client";

import { useTranslations } from "next-intl";

import { documentBadgeClass, documentStatusKey, signerBadgeClass, signerStatusKey } from "@/lib/sign/client/status";
import type { SignerKind } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

const BASE = "inline-flex h-5 w-fit shrink-0 items-center rounded-full px-2 text-xs font-medium whitespace-nowrap";

/** The status of a document as a word on a soft tint (the word is the signal; the tint only helps). */
export function DocumentStatusBadge({ status, className }: { status: string; className?: string }) {
  const t = useTranslations("Sign.send");
  return <span className={cn(BASE, documentBadgeClass(status), className)}>{t(documentStatusKey(status))}</span>;
}

/** The status of one person on a document. */
export function SignerStatusBadge({ status, kind = "signer", className }: { status: string; kind?: SignerKind; className?: string }) {
  const t = useTranslations("Sign.send");
  return <span className={cn(BASE, signerBadgeClass(status), className)}>{t(signerStatusKey(status, kind))}</span>;
}
