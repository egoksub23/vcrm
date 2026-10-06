// ============================================================
// /verify/[id]: the page a person reaches by scanning the code on a signed document's certificate. It
// shows that the document was completed, when and by whom, whether its record of events is intact, and
// lets them check the copy they hold against the signed original (in their browser: nothing is uploaded).
// A server component, so the first paint already has the facts. An address that is not a signed document
// is a 404 with a plain page (not-found.tsx) that says nothing about whether a document exists.
// ============================================================

import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { loadSignerMessages } from "@/components/sign/signer/load-messages";
import { VerifyNotFoundRoot, VerifyRoot } from "@/components/sign/verify/verify-root";
import { localeFromAcceptLanguage, resolveSignerLocale } from "@/lib/sign/client/signer-flow";

import { loadVerifyPage } from "./load";

interface PageProps {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

const productName = () => process.env.NEXT_PUBLIC_APP_NAME?.trim() || "Halo";

export async function generateMetadata({ params }: Pick<PageProps, "params">): Promise<Metadata> {
  const { id } = await params;
  const loaded = await loadVerifyPage(id);
  return loaded.kind === "ok" ? { title: loaded.view.title } : {};
}

export default async function VerifyPage({ params, searchParams }: PageProps) {
  const { id } = await params;
  const query = await searchParams;
  const loaded = await loadVerifyPage(id);
  if (loaded.kind === "invalid") notFound();

  // no document language is on file for a stranger: ?lang=, then the browser's own
  const initialLocale = resolveSignerLocale({ query: query.lang, fallback: localeFromAcceptLanguage((await headers()).get("accept-language")) });
  const messages = await loadSignerMessages({ verify: true });
  if (loaded.kind === "busy") return <VerifyNotFoundRoot busy initialLocale={initialLocale} messages={messages} product={productName()} />;
  return <VerifyRoot view={loaded.view} initialLocale={initialLocale} messages={messages} product={productName()} />;
}
