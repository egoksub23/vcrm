import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The verify page (the QR code on a certificate) for a form WITHOUT a signature (migration 169): it says the submission is recorded and who
// submitted, and checks the copy against the sealed record, in every language. Runs once the message fragment of this work package is
// merged into messages/*.json; skips until then.

import { loadSignerMessages } from "@/components/sign/signer/load-messages";
import type { SignerMessages } from "@/components/sign/signer/use-language";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import type { VerifyView } from "@/lib/sign/service/verify";

import { VerifyRoot } from "./verify-root";

const LOCALES: SignerLocale[] = ["en", "ms", "zh", "ko"];
let messages: SignerMessages;
let merged = false;

beforeAll(async () => {
  messages = await loadSignerMessages({ verify: true });
  merged = Boolean((messages.en as unknown as { Sign?: { verify?: { signedTitleForm?: string } } }).Sign?.verify?.signedTitleForm);
});

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const view = (over: Partial<VerifyView> = {}): VerifyView => ({
  title: "E-invoice details",
  reference: "SGN-1",
  pageCount: 3,
  completedAt: "2026-10-06T08:30:00Z",
  workspace: { name: "Vircle", logoUrl: null },
  signers: [{ name: "Ali bin Ahmad", signedAt: "2026-10-06T08:20:00Z" }],
  sha256: "ab".repeat(32),
  chain: "intact",
  events: 9,
  mode: "form",
  ...over,
});

const page = (v: VerifyView, locale: SignerLocale = "en") => renderToStaticMarkup(<VerifyRoot view={v} initialLocale={locale} messages={messages} product="Halo" />);

describe("the verify page of a form without a signature", () => {
  it("says the submission is recorded, who submitted, and checks the sealed record", () => {
    if (!merged) return;
    const html = page(view());
    expect(html).toContain("This submission is recorded");
    expect(html).not.toContain("This document is signed");
    expect(html).toContain("Submitted by");
    expect(html).not.toContain("Signed by");
    expect(html).toContain("Ali bin Ahmad");
    expect(html).toContain("Check your copy");
    expect(html).toContain("Fingerprint of the sealed record (SHA-256)");
    expect(page(view({ signers: [] }))).toContain("No submissions are listed for this document.");
  });

  it("renders in every language with no raw key", () => {
    if (!merged) return;
    for (const locale of LOCALES) {
      const html = page(view(), locale);
      expect(/Sign\.verify|signedTitleForm|signers\.titleForm|check\.[a-zA-Z]+Form/.test(html), locale).toBe(false);
      expect(html).toContain(`lang="${locale}"`);
    }
    expect(page(view(), "ms")).toContain("Penghantaran ini direkodkan");
    expect(page(view(), "zh")).toContain("此提交已记录");
    expect(page(view(), "ko")).toContain("이 제출은 기록되었습니다");
    expect(errors).toEqual([]);
  });

  it("leaves an agreement's page as it was", () => {
    const html = page(view({ mode: undefined }));
    expect(html).toContain("This document is signed");
    expect(html).toContain("Signed by");
    expect(html).not.toContain("This submission is recorded");
  });
});
