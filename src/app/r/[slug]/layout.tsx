// ============================================================
// /r/[slug] layout: a public registration page. A person opens it from a link the workspace shared (a message,
// a QR code, a website), with no login, mostly on a phone. It has the signing page's own minimal frame, not the
// dashboard.
//
//   - Referrer-Policy: no-referrer. The address is the workspace's private link to its applicants: nothing the page
//     loads (the logo, the optional Turnstile script) may be told where it was loaded from.
//   - noindex: a registration page is shared on purpose, not to be found by a search engine.
//   - Content-Security-Policy: this route (and only this route) may also reach Cloudflare Turnstile; see next.config.ts.
// ============================================================

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Register",
  referrer: "no-referrer",
  robots: { index: false, follow: false, nocache: true },
};

export default function RegisterLayout({ children }: { children: ReactNode }) {
  return children;
}
