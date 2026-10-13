// ============================================================
// /c/link/[token]: the personal account closure form (Compliance requests, migration 185). A member of staff sent the parent this address in their chat as a
// card with a button. No login and no emailed code: the link is the parent's key (one case, single use, 14 days). A server component: it checks the link and
// draws the form itself, so the first paint already has the workspace's name, the right language and the fields.
//
// ONE calm page for every link that does not work (unknown, used, withdrawn, replaced, expired, Compliance off): "This link is not valid any more. Please
// contact support." It never says which, and never names the workspace.
// ============================================================

import type { Metadata } from "next";
import { headers } from "next/headers";

import { LinkNotValid, LinkRoot, PublicNotAvailable } from "@/components/compliance/public/public-form";
import { loadLinkPage } from "@/lib/compliance/chat-link/public";
import { publicEnv } from "@/lib/compliance/public/http";
import { clientIp } from "@/lib/net/client-ip";
import { localeFromAcceptLanguage, resolveSignerLocale } from "@/lib/sign/client/signer-flow";

// each visit carries its own signed token: nothing about this page may be reused between visitors
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

// (the title never names the workspace, so a shared preview says nothing it need not)
export const metadata: Metadata = { title: "Request form", robots: { index: false, follow: false, nocache: true } };

export default async function PersonalFormPage({ params, searchParams }: PageProps) {
  const { token } = await params;
  const query = await searchParams;
  const requestHeaders = await headers();
  const browserLocale = localeFromAcceptLanguage(requestHeaders.get("accept-language"));
  const out = await loadLinkPage(publicEnv(), token, clientIp(requestHeaders), browserLocale);
  if (out.kind === "invalid") return <LinkNotValid initialLocale={browserLocale} />;
  if (out.kind === "busy") return <PublicNotAvailable initialLocale={browserLocale} busy />;
  return <LinkRoot view={out.view} initialLocale={resolveSignerLocale({ query: query.lang, fallback: out.view.locale })} />;
}
