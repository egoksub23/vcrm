// ============================================================
// /c/link layout: the personal closure form (Compliance requests, migration 185). A parent opens it from the button in their chat, with no login, mostly on a
// phone. The address IS the parent's key, so:
//
//   - Referrer-Policy: no-referrer. Nothing the page loads (the workspace's logo) may be told the address it was loaded from.
//   - noindex, nocache: it is never to be found or kept by a search engine.
//   - Cache-Control: private, no-store comes from next.config.ts (the /c/:slug* rule matches this address too), with the same Content-Security-Policy.
// ============================================================

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Request form",
  referrer: "no-referrer",
  robots: { index: false, follow: false, nocache: true },
};

export default function PersonalFormLayout({ children }: { children: ReactNode }) {
  return children;
}
