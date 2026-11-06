// /report/[token]: the coach's report, opened from the coach portal (in a new tab, an iframe or a web view). No login and no cookie: the link carries
// everything. The page is drawn on the server from the link, so a bad or expired link never reaches the form. Framing is allowed only from the
// origins registered for the key (the proxy sets frame-ancestors from the token).
import type { Metadata } from "next";

import { ReportApp, ReportNotice } from "@/components/incidents/report/report-app";
import { intakeDeps } from "@/lib/incidents/intake/runtime";
import { readSessionToken } from "@/lib/incidents/intake/keys";
import { loadReport } from "@/lib/incidents/intake/service";

export const metadata: Metadata = { title: "Report an incident", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

export default async function ReportPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const origins = readSessionToken(token)?.origins ?? [];
  const view = await loadReport(intakeDeps(), token);

  if (view.state === "open") return <ReportApp token={token} view={view} origins={origins} />;
  if (view.state === "submitted") return <ReportNotice kind="submitted" reference={view.reference} returnUrl={view.returnUrl} origins={origins} />;
  return <ReportNotice kind={view.state} origins={origins} />;
}
