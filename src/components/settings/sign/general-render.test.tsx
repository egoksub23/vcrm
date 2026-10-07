import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// Settings > Secure Sign > General: the certificate choice (migration 178), first paint, in every language with the screens' real messages. The certificate
// of completion is always a file of its own; "Also embed the certificate inside the signed PDF" is a switch that is OFF until the workspace chooses, and
// that only someone who may change the settings can move.

vi.mock("@/hooks/use-can", () => ({ useCapability: () => canEdit.value }));
vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
const canEdit = vi.hoisted(() => ({ value: true }));

import type { SignSettingsRow } from "@/lib/sign/types";
import { GeneralSection } from "./general-section";

const LOCALES = ["en", "ms", "zh", "ko"] as const;
type Tree = Record<string, unknown>;
const signMessages = (locale: string) => (JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as { Sign: Tree }).Sign;
const text = (locale: string, path: string) => path.split(".").reduce<unknown>((n, k) => (n as Tree)[k], signMessages(locale)) as string;
const clean = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/<!-- -->/g, "");

const settings = (over: Partial<SignSettingsRow> = {}): SignSettingsRow => ({
  id: "set1",
  account_id: "a1",
  default_expiry_days: 14,
  reminder_days: [3, 7],
  default_language: "en",
  consent_texts: {},
  sender_name: null,
  logo_path: null,
  retention_years: 7,
  certificate_id: null,
  whatsapp_template_name: null,
  whatsapp_template_language: "en",
  ...over,
});

function render(locale: string, row: SignSettingsRow) {
  return clean(
    renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} timeZone="UTC" messages={{ Sign: signMessages(locale) }} onError={(e) => { throw e; }}>
        <GeneralSection settings={row} onSaved={() => undefined} />
      </NextIntlClientProvider>,
    ),
  );
}

/** The opening tag of the switch (the checkbox that points at the hint under it). */
const box = (html: string) => html.match(/<span[^>]*role="checkbox"[^>]*aria-describedby="sign-embed-certificate-hint"[^>]*>/)?.[0] ?? "";
const DISABLED = /aria-disabled="true"|data-disabled/;

describe.each(LOCALES)("the certificate choice on the General settings (%s)", (locale) => {
  it("says the certificate is a file of its own and offers the switch, off until the workspace chooses", () => {
    canEdit.value = true;
    for (const row of [settings(), settings({ embed_certificate: false })]) {
      const html = render(locale, row);
      expect(html).toContain(text(locale, "admin.general.certificateTitle"));
      expect(html).toContain(text(locale, "admin.general.certificateIntro"));
      expect(html).toContain(text(locale, "admin.general.embedCertificate"));
      expect(html).toContain(text(locale, "admin.general.embedCertificateHint"));
      expect(box(html)).toContain('aria-checked="false"');
      expect(box(html)).not.toMatch(DISABLED);
      expect(html).not.toMatch(/admin\.general\./);
    }
    // the words differ from English outside English
    if (locale !== "en") expect(text(locale, "admin.general.embedCertificate")).not.toBe(text("en", "admin.general.embedCertificate"));
  });

  it("shows the switch on when the workspace chose it, and cannot be moved by someone who may not change the settings", () => {
    canEdit.value = true;
    expect(box(render(locale, settings({ embed_certificate: true })))).toContain('aria-checked="true"');
    canEdit.value = false;
    const locked = render(locale, settings({ embed_certificate: true }));
    expect(box(locked)).toMatch(DISABLED);
    expect(box(locked)).toContain('aria-checked="true"');
    canEdit.value = true;
  });
});

describe("the wording", () => {
  it("is exactly what the owner asked for in English", () => {
    expect(text("en", "admin.general.embedCertificate")).toBe("Also embed the certificate inside the signed PDF");
  });

  it("never says the retired names", () => {
    for (const locale of LOCALES) {
      for (const key of ["certificateTitle", "certificateIntro", "embedCertificate", "embedCertificateHint"]) {
        const value = text(locale, `admin.general.${key}`);
        expect(value, `${locale}.${key}`).not.toMatch(/Doc Sign|envelope/i);
      }
    }
  });
});
