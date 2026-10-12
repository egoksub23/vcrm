// ============================================================
// /c/[slug] layout: a public parent form. A parent opens it from a link the workspace shared (a message, an email, a website), with no login, mostly on a
// phone. It has its own minimal frame, not the dashboard.
//
//   - Referrer-Policy: no-referrer. The address is the workspace's private link to its customers: nothing the page loads (the logo, the optional
//     Turnstile script) may be told where it was loaded from.
//   - noindex: a parent form is shared on purpose, not to be found by a search engine.
//   - Cache-Control: private, no-store, and the Content-Security-Policy that lets this route (and only this route) reach Cloudflare Turnstile: see
//     next.config.ts.
// ============================================================

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Request form",
  referrer: "no-referrer",
  robots: { index: false, follow: false, nocache: true },
};

export default function PublicFormLayout({ children }: { children: ReactNode }) {
  return children;
}
