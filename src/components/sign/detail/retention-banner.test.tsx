import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import { bannerFor, retentionState } from "./logic";
import { StatusBanner } from "./status-banner";

// A signed document shows how long it is kept. The logic is pure; the screen is rendered in every language with the
// real wording and next-intl set to throw on a missing key instead of printing a raw key path.

const caps = { settings: true };
const base = { status: "completed", completed_at: "2026-10-06T00:00:00Z", expires_at: null, void_reason: null, seal_error: null };

describe("retentionState", () => {
  const now = new Date("2026-10-06T08:00:00Z");
  it("says whether the date is still ahead", () => {
    expect(retentionState("2033-10-06T08:00:00Z", now)).toBe("kept");
    expect(retentionState("2026-10-06T08:00:01Z", now)).toBe("kept");
    expect(retentionState("2026-10-06T08:00:00Z", now)).toBe("ended");
    expect(retentionState("2020-01-01T00:00:00Z", now)).toBe("ended");
  });
  it("has nothing to say without a date", () => {
    expect(retentionState(null, now)).toBeNull();
    expect(retentionState(undefined, now)).toBeNull();
    expect(retentionState("not a date", now)).toBeNull();
  });
});

describe("bannerFor", () => {
  it("carries the retention date of a completed document, and only then", () => {
    expect(bannerFor({ ...base, retain_until: "2033-10-06T08:00:00Z" }, [], caps)).toEqual({ kind: "completed", at: "2026-10-06T00:00:00Z", retainUntil: "2033-10-06T08:00:00Z" });
    expect(bannerFor({ ...base, retain_until: null }, [], caps)).toEqual({ kind: "completed", at: "2026-10-06T00:00:00Z" });
    expect(bannerFor({ ...base, status: "sealing", retain_until: "2033-10-06T08:00:00Z" }, [], caps)).toEqual({ kind: "sealing" });
  });
});

function messages(locale: string): Record<string, unknown> | null {
  const file = join(process.cwd(), "messages", `${locale}.json`);
  if (!existsSync(file)) return null;
  const detail = (JSON.parse(readFileSync(file, "utf8")) as { Sign?: { detail?: { banner?: Record<string, unknown> } } }).Sign?.detail;
  return detail?.banner?.retainedUntil ? detail : null;
}
const LOCALES = ["en", "ms", "zh", "ko"].filter((l) => messages(l) !== null);

function render(locale: string, retainUntil: string) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={{ Sign: { detail: messages(locale) } }}
      onError={(e) => {
        throw e;
      }}
    >
      <StatusBanner banner={bannerFor({ ...base, retain_until: retainUntil }, [], caps)} />
    </NextIntlClientProvider>,
  );
}

describe.skipIf(LOCALES.length === 0)("the retention line on a signed document", () => {
  for (const locale of LOCALES) {
    it(`says it is kept, or that retention ended, with a date (${locale})`, () => {
      const kept = render(locale, "2099-10-06T08:00:00Z");
      const ended = render(locale, "2020-01-01T00:00:00Z");
      expect(kept).not.toBe(ended);
      expect(kept).toContain("2099");
      expect(ended).toContain("2020");
      expect(kept).not.toContain("retainedUntil");
      expect(ended).not.toContain("retentionEnded");
    });
  }
});
