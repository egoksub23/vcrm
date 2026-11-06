// /report/[token]: the coach's report, opened from the coach portal (in a new tab, an iframe or a web view). No login and no cookie: the link carries
// everything. The page is drawn on the server from the link, so a bad or expired link never reaches the form. Framing is allowed only from the
// origins registered for the key (the proxy sets frame-ancestors from the token).
import type { Metadata } from "next";
import { headers } from "next/headers";
import { NextIntlClientProvider } from "next-intl";

import { ReportApp, ReportNotice } from "@/components/incidents/report/report-app";
import { intakeDeps } from "@/lib/incidents/intake/runtime";
import { readSessionToken } from "@/lib/incidents/intake/keys";
import { pickLang } from "@/lib/incidents/intake/lang";
import { loadReport } from "@/lib/incidents/intake/service";
import { mergeMessages } from "@/lib/i18n/locales";

export const metadata: Metadata = { title: "Report an incident", robots: { index: false, follow: false }, referrer: "no-referrer" };
export const dynamic = "force-dynamic";

/** Only the page's own words, in the language chosen, with English underneath for anything not yet translated. */
async function reportMessages(lang: "en" | "ms" | "zh") {
  const english = (await import("../../../../messages/en.json")).default as Record<string, unknown>;
  const merged = lang === "en" ? english : mergeMessages(english as never, (await import(`../../../../messages/${lang}.json`)).default as never);
  const platform = (merged as { IncidentPlatform: { report: unknown } }).IncidentPlatform;
  return { IncidentPlatform: { report: platform.report } };
}

export default async function ReportPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ lang?: string }> }) {
  const { token } = await params;
  const lang = pickLang((await searchParams).lang, (await headers()).get("accept-language"));
  const messages = await reportMessages(lang);
  const origins = readSessionToken(token)?.origins ?? [];
  const view = await loadReport(intakeDeps(), token);

  const body =
    view.state === "open" ? (
      <ReportApp token={token} view={view} origins={origins} lang={lang} />
    ) : view.state === "submitted" ? (
      <ReportNotice kind="submitted" reference={view.reference} returnUrl={view.returnUrl} origins={origins} />
    ) : (
      <ReportNotice kind={view.state} origins={origins} />
    );
  return (
    <NextIntlClientProvider locale={lang} messages={messages}>
      {body}
    </NextIntlClientProvider>
  );
}
