import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

import type { Insights } from "@/lib/incidents/platform/insights";
import { ReportsView } from "./reports-screen";

vi.mock("next/link", () => ({ default: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a> }));

const messages = JSON.parse(readFileSync(join(process.cwd(), "messages", "en.json"), "utf8"));
const render = (data: Insights) =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale="en"
      timeZone="UTC"
      messages={messages}
      onError={(e: Error) => {
        throw e; // a missing message or argument fails the test, instead of showing a raw key
      }}
    >
      <ReportsView data={data} />
    </NextIntlClientProvider>,
  );

const base: Insights = {
  total: 5,
  raisedRecent: 4,
  raisedBefore: 1,
  open: 3,
  closed: 2,
  medianDaysToClose: 2.5,
  attention: [],
  byCategory: [{ key: "CCA injury", label: "CCA injury", count: 3, share: 0.6 }],
  bySeverity: [{ key: "high", label: "Serious", count: 5, share: 1 }],
  byPlace: [{ key: "field 1", label: "Field 1", count: 3, share: 0.6 }],
  byMonth: [{ month: "2026-10", count: 2 }, { month: "2026-11", count: 3 }],
};

describe("ReportsView", () => {
  it("says so when nothing needs attention", () => {
    const html = render(base);
    expect(html).toContain("Nothing needs attention right now");
    expect(html).toContain("CCA injury");
    expect(html).toContain("3 · 60%");
    expect(html).toContain("2.5 days");
  });

  it("writes every kind of attention item in words and links each to the incidents behind it", () => {
    const html = render({
      ...base,
      attention: [
        { kind: "overdue", count: 2, href: "/incidents?overdue=1" },
        { kind: "unacknowledged", count: 1, href: "/incidents?unack=1" },
        { kind: "seriousOpen", count: 1, href: "/incidents?open=1" },
        { kind: "stale", count: 2, days: 14, href: "/incidents?open=1" },
        { kind: "repeatStudent", name: "Arvin Raj", count: 3, href: "/incidents?student=Arvin+Raj" },
        { kind: "repeatPlace", place: "Field 1", count: 3, latest: "2026-11-05", href: "/incidents?q=Field+1" },
        { kind: "rising", recent: 4, previous: 1, href: "/incidents?from=2026-10-10" },
      ],
    });
    expect(html).toContain("2 incidents have a required step past their deadline");
    expect(html).toContain("1 incident has not been acknowledged by anyone");
    expect(html).toContain("1 serious incident is still open");
    expect(html).toContain("2 incidents have been open for 14 days or more");
    expect(html).toContain("Arvin Raj has been named on 3 incidents in the last 90 days");
    expect(html).toContain("Field 1: 3 incidents in the last 90 days, the latest on 2026-11-05");
    expect(html).toContain("4 incidents in the last 30 days, up from 1 in the 30 days before");
    expect(html).toContain('href="/incidents?overdue=1"');
    expect(html).toContain('href="/incidents?student=Arvin+Raj"');
  });

  it("explains an empty year instead of drawing empty bars, and shows a dash when nothing has been closed", () => {
    expect(render({ ...base, total: 0, attention: [] })).toContain("No incidents in the last 12 months yet");
    const html = render({ ...base, medianDaysToClose: null });
    expect(html).toContain("No incident has been closed yet");
  });
});
