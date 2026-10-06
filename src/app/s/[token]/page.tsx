// ============================================================
// /s/[token]: the page a person reaches from the link in their email or message, to read and sign a
// document. No login. A server component: it looks the link up and builds the view itself, so the first
// paint already has the document's state and the signer's language. Everything after that (the code,
// agreeing, filling in, finishing) is the client app, which talks to /api/sign/public/[token].
//
// A link that is not live (unknown, replaced, or its workspace has Doc Sign off) is a 404 with a plain
// "This link is not valid" page that says nothing about whether a document exists (not-found.tsx).
// ============================================================

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { loadSignerMessages } from "@/components/sign/signer/load-messages";
import { InvalidLinkRoot, SignerRoot } from "@/components/sign/signer/signer-root";
import { resolveSignerLocale } from "@/lib/sign/client/signer-flow";

import { loadSigning } from "./load";

interface PageProps {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

const productName = () => process.env.NEXT_PUBLIC_APP_NAME?.trim() || "Halo";

export async function generateMetadata({ params }: Pick<PageProps, "params">): Promise<Metadata> {
  const { token } = await params;
  const loaded = await loadSigning(token);
  return loaded.kind === "ok" ? { title: loaded.view.document.title } : {};
}

export default async function SignPage({ params, searchParams }: PageProps) {
  const { token } = await params;
  const query = await searchParams;
  const loaded = await loadSigning(token);
  if (loaded.kind === "invalid") notFound();

  const messages = await loadSignerMessages();
  if (loaded.kind === "busy") {
    return <InvalidLinkRoot busy initialLocale={resolveSignerLocale({ query: query.lang })} messages={messages} product={productName()} />;
  }

  return (
    <SignerRoot
      token={token}
      initialView={loaded.view}
      initialSessionOk={loaded.sessionOk}
      initialLocale={resolveSignerLocale({ query: query.lang, document: loaded.view.document.locale })}
      messages={messages}
      product={productName()}
    />
  );
}
