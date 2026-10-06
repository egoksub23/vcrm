// ============================================================
// /verify/[id] layout: the page behind the QR code on a signed document's certificate. Anyone may open it,
// with no login, mostly on a phone, so it has the signing page's own minimal frame rather than the
// dashboard. The address names a document, so nothing the page loads (the workspace's logo, a font) may be
// told it (Referrer-Policy: no-referrer), and a search engine must never index it.
// ============================================================

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Check a signed document",
  referrer: "no-referrer",
  robots: { index: false, follow: false, nocache: true },
};

export default function VerifyLayout({ children }: { children: ReactNode }) {
  return children;
}
