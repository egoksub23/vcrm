import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import type { CertificateView } from "@/lib/sign/client/certificate-view";

import { CertificateFacts } from "./certificate-facts";

// The certificate read-out in every language, with the real wording and next-intl set to throw on a missing key or
// argument instead of printing a raw key path. Each kind of certificate is shown: the one Halo made, one the
// workspace uploaded that is self-signed, and one from an authority (with its warnings, and expired).

function admin(locale: string): Record<string, unknown> | null {
  const file = join(process.cwd(), "messages", `${locale}.json`);
  if (!existsSync(file)) return null;
  const a = (JSON.parse(readFileSync(file, "utf8")) as { Sign?: { admin?: { certificate?: { uploadTitle?: string } } & Record<string, unknown> } }).Sign?.admin;
  return a?.certificate?.uploadTitle ? a : null;
}
const LOCALES = ["en", "ms", "zh", "ko"].filter((l) => admin(l) !== null);

const NOW = new Date("2026-10-06T08:00:00Z");
const view = (over: Partial<CertificateView> = {}): CertificateView => ({
  id: "c1",
  name: "Uploaded: Kedai Runcit Ali Sdn Bhd",
  uploaded: true,
  subject: "Kedai Runcit Ali Sdn Bhd, Kedai Runcit Ali, MY",
  issuer: "Test Issuing CA, Test Trust Sdn Bhd, MY",
  serial: "0123456789ABCDEF0123456789ABCDEF",
  validFrom: "2026-09-01T00:00:00Z",
  validUntil: "2027-09-01T00:00:00Z",
  selfSigned: false,
  fingerprint: "ab".repeat(32),
  chainLength: 3,
  keyBits: 2048,
  warnings: [],
  readable: true,
  ...over,
});

function render(locale: string, cert: CertificateView | null) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={{ Sign: { admin: admin(locale) } }}
      onError={(e) => {
        throw e;
      }}
    >
      <CertificateFacts cert={cert} now={NOW} />
    </NextIntlClientProvider>,
  );
}

describe.skipIf(LOCALES.length === 0)("the certificate read-out", () => {
  for (const locale of LOCALES) {
    it(`shows every fact and the note about what readers say, for each kind of certificate (${locale})`, () => {
      const authority = render(locale, view());
      expect(authority).toContain("Kedai Runcit Ali Sdn Bhd, Kedai Runcit Ali, MY");
      expect(authority).toContain("Test Issuing CA");
      expect(authority).toContain("…0123456789ABCDEF");
      expect(authority).toContain("AB:AB:AB");
      expect(authority).toContain("2048");

      const generated = render(locale, view({ uploaded: false, selfSigned: true, issuer: "Vircle (Halo Doc Sign)", subject: "Vircle (Halo Doc Sign)", name: "Halo self-signed (not trusted by PDF readers)", chainLength: 1 }));
      const uploadedSelf = render(locale, view({ selfSigned: true, chainLength: 1 }));
      // each kind says something different about what a reader will show
      expect(new Set([authority, generated, uploadedSelf]).size).toBe(3);

      // warnings, an expired certificate, an unreadable one, and no certificate yet
      const warned = render(locale, view({ warnings: ["chain_missing", "weak_signature_algorithm", "chain_certificate_expired", "not_for_document_signing"] }));
      expect(warned.length).toBeGreaterThan(authority.length);
      const expired = render(locale, view({ validUntil: "2026-10-01T00:00:00Z" }));
      expect(expired).toContain('role="alert"');
      render(locale, view({ readable: false, subject: null, issuer: null, serial: null, validFrom: null, fingerprint: null, chainLength: null, keyBits: null }));
      expect(render(locale, null).length).toBeGreaterThan(0);
    });
  }
});
