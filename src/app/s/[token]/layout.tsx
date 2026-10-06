// ============================================================
// /s/[token] layout: the signing page. A person opens it from the link in an email or a message, with no
// login, mostly on a phone. It has its own minimal frame (not the dashboard) and brings its own language.
//
// The token is in the address, so:
//   - Referrer-Policy: no-referrer. Nothing the page loads (the workspace's logo, a font) may be told the
//     address it was loaded from. Per Next's `metadata` this becomes <meta name="referrer">.
//   - noindex: a signing link must never be found by a search engine.
// The script font for typed signatures is loaded by next/font, which serves it from this site.
// ============================================================

import type { Metadata } from "next";
import type { ReactNode } from "react";

import { signatureFont } from "@/components/sign/signer/signature-font";

export const metadata: Metadata = {
  title: "Sign",
  referrer: "no-referrer",
  robots: { index: false, follow: false, nocache: true },
};

export default function SignerLayout({ children }: { children: ReactNode }) {
  return <div className={signatureFont.variable}>{children}</div>;
}
