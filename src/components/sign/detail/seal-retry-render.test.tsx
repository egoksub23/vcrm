import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// The sender's side of a sealing that stopped: the banner says so (and why, to the people who may read it), and "Try again" is there. Rendered in
// every language with the real wording; next-intl is told to throw on a missing key.

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import messagesEn from "../../../../messages/en.json";
import messagesMs from "../../../../messages/ms.json";
import messagesZh from "../../../../messages/zh.json";
import messagesKo from "../../../../messages/ko.json";

import { bannerFor, detailErrorKey } from "./logic";
import { SealRetry } from "./seal-retry";
import { StatusBanner } from "./status-banner";

const ALL = { en: messagesEn, ms: messagesMs, zh: messagesZh, ko: messagesKo } as const;
const doc = (over: Record<string, unknown>) => ({ status: "sealing", completed_at: null, expires_at: null, void_reason: null, seal_error: null, ...over });

function page(locale: keyof typeof ALL, node: React.ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={{ Sign: { detail: ALL[locale].Sign.detail } }}
      timeZone="UTC"
      onError={(e) => {
        throw e;
      }}
      getMessageFallback={({ key }) => {
        throw new Error(`missing ${key}`);
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

describe("a signed copy that could not be made", () => {
  it("says the last try did not work, with the reason for people who read technical notes, and offers Try again", () => {
    const banner = bannerFor(doc({ seal_error: "ENOENT: no such file" }), [], { settings: true });
    const html = page("en", <StatusBanner banner={banner} retry={<SealRetry path="/api/sign/documents/d1/retry-seal" onDone={async () => undefined} />} />);
    expect(html).toContain("The last try at the signed copy did not work (ENOENT: no such file)");
    expect(html).toContain("Nothing the people signed is lost");
    expect(html).toContain("Try again");
    // the others are told it is being tried again, without the technical note
    const quiet = page("en", <StatusBanner banner={bannerFor(doc({ seal_error: "ENOENT: no such file" }), [], { settings: false })} />);
    expect(quiet).toContain("The last try at the signed copy did not work.");
    expect(quiet).not.toContain("ENOENT");
    expect(quiet).not.toContain("Try again");
  });

  it("offers Try again on a document that is marked failed", () => {
    const banner = bannerFor(doc({ status: "failed", seal_error: "boom" }), [], { settings: true });
    const html = page("en", <StatusBanner banner={banner} retry={<SealRetry path="/api/sign/documents/d1/retry-seal" onDone={async () => undefined} />} />);
    expect(html).toContain("Could not be sealed");
    expect(html).toContain("Technical note: boom");
    expect(html).toContain("Try again");
  });

  it("is worded in every language, and the refusal code is a known one", () => {
    for (const locale of ["en", "ms", "zh", "ko"] as const) {
      const banner = bannerFor(doc({ seal_error: "boom" }), [], { settings: true });
      const html = page(locale, <StatusBanner banner={banner} retry={<SealRetry path="/x" onDone={async () => undefined} />} />);
      expect(html).toContain("boom");
      expect(html).toContain("<button");
      expect(ALL[locale].Sign.detail.sealRetry.button.length).toBeGreaterThan(1);
      expect(ALL[locale].Sign.detail.events.seal_retried).toContain("{sender}");
    }
    expect(detailErrorKey("seal_not_stuck")).toBe("errors.seal_not_stuck");
  });
});
