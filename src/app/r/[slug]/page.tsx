// ============================================================
// /r/[slug]: a registration page. A person opens the link a workspace shared, enters a few details, and the
// signing flow starts: the document goes to the email they entered, which is also what proves the address is
// theirs. No login. A server component: it looks the form up and builds the view itself, so the first paint
// already has the workspace's name and logo, the fields chosen, and the right language. The form after that
// is the client (components/sign/register), which posts to /api/sign/register/[slug].
//
// An address that is not a live page (unknown, switched off, or Doc Sign is off for the workspace) is a 404 with a
// plain "this page is not available" that says nothing about which it was (not-found.tsx).
// ============================================================

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { loadSignerMessages } from "@/components/sign/signer/load-messages";
import { RegisterNotFoundRoot, RegisterRoot } from "@/components/sign/register/register-root";
import { resolveSignerLocale } from "@/lib/sign/client/signer-flow";

import { loadRegisterPage } from "./load";

// each visit carries its own signed token: nothing about this page may be reused between visitors
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

const productName = () => process.env.NEXT_PUBLIC_APP_NAME?.trim() || "Halo";

export async function generateMetadata({ params }: Pick<PageProps, "params">): Promise<Metadata> {
  const { slug } = await params;
  const loaded = await loadRegisterPage(slug);
  return loaded.kind === "ok" ? { title: loaded.view.workspace.name } : {};
}

export default async function RegisterPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const query = await searchParams;
  const loaded = await loadRegisterPage(slug);
  if (loaded.kind === "invalid") notFound();

  const messages = await loadSignerMessages({ register: true });
  const initialLocale = resolveSignerLocale({ query: query.lang, document: loaded.kind === "ok" ? loaded.view.defaultLocale : null });
  if (loaded.kind === "busy" || loaded.kind === "unavailable") {
    return <RegisterNotFoundRoot kind={loaded.kind} initialLocale={initialLocale} messages={messages} product={productName()} />;
  }
  return <RegisterRoot view={loaded.view} initialLocale={initialLocale} messages={messages} product={productName()} />;
}
