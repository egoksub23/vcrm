import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Render smoke tests for the verify page (the QR code on a certificate): it renders from a view, in every
// language, with the page's real messages, and none shows a raw key. Effects do not run under
// renderToStaticMarkup, so what is checked is the first paint, which is what the server sends.

import { loadSignerMessages } from "@/components/sign/signer/load-messages";
import type { SignerMessages } from "@/components/sign/signer/use-language";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import type { VerifyView } from "@/lib/sign/service/verify";

import { VerifyNotFoundRoot, VerifyRoot } from "./verify-root";

const LOCALES: SignerLocale[] = ["en", "ms", "zh", "ko"];
let messages: SignerMessages;

beforeAll(async () => {
  messages = await loadSignerMessages({ verify: true });
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
  title: "Merchant Application: Kedai Runcit",
  reference: "MA-0001",
  pageCount: 4,
  completedAt: "2026-10-06T08:30:00Z",
  workspace: { name: "Kedai Runcit Ali", logoUrl: "https://example.test/logo.png" },
  signers: [
    { name: "Ali bin Ahmad", signedAt: "2026-10-06T08:20:00Z" },
    { name: "Siti Director", signedAt: "2026-10-06T08:25:00Z" },
  ],
  sha256: "ab".repeat(32),
  chain: "intact",
  events: 14,
  ...over,
});

const page = (v: VerifyView, locale: SignerLocale = "en") => renderToStaticMarkup(<VerifyRoot view={v} initialLocale={locale} messages={messages} product="Halo" />);

// a message key left untranslated reads like "Sign.verify.check.title" or "check.title"
const looksLikeKey = (html: string) => /Sign\.verify|trail\.[a-z]+Title|check\.[a-z]+Title|signers\.title/.test(html);

describe("the verify page, first paint", () => {
  it("shows the workspace, the document, who signed and the fingerprint", () => {
    const html = page(view());
    expect(html).toContain('alt="Kedai Runcit Ali"');
    expect(html).toContain("This document is signed");
    expect(html).toContain("Merchant Application: Kedai Runcit");
    expect(html).toContain("Reference MA-0001");
    expect(html).toContain("4 pages");
    expect(html).toContain("Ali bin Ahmad");
    expect(html).toContain("Siti Director");
    expect(html).toContain("ab".repeat(32));
    expect(html).toContain("Check your copy");
    expect(html).toContain('type="file"');
    expect(html).toContain("The record of this document is complete and unchanged");
  });

  it("raises the alarm when the record of events does not match", () => {
    const html = page(view({ chain: "broken" }));
    expect(html).toContain("The record of this document does not match");
    expect(html).toContain('role="alert"');
    expect(html).not.toContain("complete and unchanged");
  });

  it("says plainly when the record could not be checked", () => {
    const html = page(view({ chain: "unknown", events: null }));
    expect(html).toContain("The record could not be checked");
    expect(html).not.toContain("complete and unchanged");
  });

  it("leaves out what is not there: a reference, a page count, the logo, the signers", () => {
    const html = page(view({ reference: null, pageCount: null, workspace: { name: "Kedai Runcit Ali", logoUrl: null }, signers: [] }));
    expect(html).not.toContain("Reference ");
    expect(html).not.toContain(" pages");
    expect(html).not.toContain("<img");
    expect(html).toContain("No signatures are listed for this document.");
  });

  it("renders in every language with no raw key and no React error", () => {
    for (const locale of LOCALES) {
      const html = page(view(), locale);
      expect(looksLikeKey(html), locale).toBe(false);
      expect(html).toContain(`lang="${locale}"`);
      expect(html).toContain("ab".repeat(32));
    }
    expect(errors).toEqual([]);
  });

  it("is written in the person's own language", () => {
    expect(page(view(), "ms")).toContain("Dokumen ini telah ditandatangani");
    expect(page(view(), "zh")).toContain("此文件已签署");
    expect(page(view(), "ko")).toContain("서명이 완료된 문서입니다");
  });
});

describe("the page for an address that is not a signed document", () => {
  const missing = (locale: SignerLocale, busy = false) => renderToStaticMarkup(<VerifyNotFoundRoot busy={busy} initialLocale={locale} messages={messages} product="Halo" />);

  it("says nothing about any workspace or document, in every language", () => {
    for (const locale of LOCALES) {
      const html = missing(locale);
      expect(looksLikeKey(html), locale).toBe(false);
      expect(html).not.toContain("<img");
      expect(html).not.toContain("Kedai");
    }
    expect(missing("en")).toContain("We could not find this document");
    expect(errors).toEqual([]);
  });

  it("asks a busy visitor to wait, and does not say the document is missing", () => {
    const html = missing("en", true);
    expect(html).toContain("Please wait a moment");
    expect(html).not.toContain("could not find");
  });
});
