// ============================================================
// /v/[token]: the page a person reaches from a Secure Share link.
// No login required. Server component: looks up the share and builds
// the view; the PDF viewer is the client component ShareViewer.
// ============================================================

import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { HtmlViewer } from "@/components/share/viewer/html-viewer";
import { ShareGate } from "@/components/share/viewer/share-gate";
import { ShareViewer } from "@/components/share/viewer/share-viewer";
import { UrlRedirect } from "@/components/share/viewer/url-redirect";
import { loadShare } from "./load";

interface PageProps {
  params: Promise<{ token: string }>;
}

const productName = () => process.env.NEXT_PUBLIC_APP_NAME?.trim() || "Halo";

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { token } = await params;
  const loaded = await loadShare(token);
  return loaded.kind === "ok" ? { title: loaded.share.title } : {};
}

export default async function ShareViewPage({ params }: PageProps) {
  const { token } = await params;
  const loaded = await loadShare(token);

  if (loaded.kind === "invalid") notFound();
  if (loaded.kind === "busy") {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground text-sm">
        Too many requests. Please try again in a moment.
      </div>
    );
  }

  const product = productName();
  const { share } = loaded;

  if (!share.gateCleared && share.gateType !== "none") {
    return (
      <ShareGate
        token={token}
        title={share.title}
        gateType={share.gateType as "email" | "otp"}
        product={product}
      />
    );
  }

  if (share.kind === "url" && share.redirectUrl) {
    return (
      <UrlRedirect
        token={token}
        title={share.title}
        redirectUrl={share.redirectUrl}
        product={product}
      />
    );
  }

  if (share.contentType === "text/html") {
    return (
      <HtmlViewer
        token={token}
        share={share}
        product={product}
      />
    );
  }

  return (
    <ShareViewer
      token={token}
      initialShare={share}
      product={product}
    />
  );
}
