// ============================================================
// /c/[slug]: the parent form (Compliance requests). A parent opens the link a workspace shared, confirms an email address with a code, fills the account
// closure or the withdrawal form, and sees a confirmation with a reference. No login. A server component: it looks the form up and builds the view itself,
// so the first paint already has the workspace's name, the right language and the fields. The form after that is the client
// (components/compliance/public), which posts to /api/compliance/public/[slug]/*.
//
// An address that is not a live form (unknown, switched off, or the workspace has Compliance off) is a 404 with a plain "this form is not available"
// that says nothing about which it was (not-found.tsx).
// ============================================================

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublicNotAvailable, PublicRoot } from "@/components/compliance/public/public-form";
import { localeFromAcceptLanguage, resolveSignerLocale } from "@/lib/sign/client/signer-flow";
import { headers } from "next/headers";

import { loadPublicPage } from "./load";

// each visit carries its own signed token and its own session: nothing about this page may be reused between visitors
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}

// (the title is the form's own name; it never names the workspace, so a shared link preview says nothing it need not)
export const metadata: Metadata = { title: "Request form", robots: { index: false, follow: false, nocache: true } };

export default async function PublicFormPage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const query = await searchParams;
  const loaded = await loadPublicPage(slug);
  if (loaded.kind === "invalid") notFound();
  const initialLocale = resolveSignerLocale({ query: query.lang, fallback: localeFromAcceptLanguage((await headers()).get("accept-language")) });
  if (loaded.kind === "busy" || loaded.kind === "unavailable") return <PublicNotAvailable initialLocale={initialLocale} busy={loaded.kind === "busy"} />;
  return <PublicRoot view={loaded.view} initialLocale={initialLocale} />;
}
