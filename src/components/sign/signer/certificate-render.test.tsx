import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// The signer's finished screens when the certificate is a file of its own (migration 178), in every language with the page's real messages: the signed
// document, the certificate and everything in one zip, each its own button with its own address; a document whose certificate is inside the signed PDF
// keeps the buttons it had; nothing is offered before the code is entered or while the document is not complete. Effects do not run under
// renderToStaticMarkup, so this is the first paint.

import type { EnvelopeDocView, EnvelopeView, SigningView } from "@/lib/sign/service/signing";
import { scopeOf } from "@/lib/sign/client/scope";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";

import { EnvelopeEnd } from "./envelope-bar";
import { EndScreen } from "./end-screens";
import { loadSignerMessages } from "./load-messages";
import type { SignerMessages } from "./use-language";

const LOCALES: SignerLocale[] = ["en", "ms", "zh", "ko"];
const WORDS: Record<SignerLocale, { signed: string; record: string; certificate: string; all: string; old: string; oldRecord: string }> = {
  en: { signed: "Signed document", record: "Sealed record", certificate: "Certificate", all: "Download all (zip)", old: "Download signed PDF", oldRecord: "Download the record" },
  ms: { signed: "Dokumen bertandatangan", record: "Rekod termeterai", certificate: "Sijil", all: "Muat turun semua (zip)", old: "", oldRecord: "" },
  zh: { signed: "已签署文件", record: "封存记录", certificate: "证书", all: "全部下载 (zip)", old: "", oldRecord: "" },
  ko: { signed: "서명된 문서", record: "봉인된 기록", certificate: "증명서", all: "모두 다운로드 (zip)", old: "", oldRecord: "" },
};

let messages: SignerMessages;
beforeAll(async () => {
  messages = await loadSignerMessages();
});

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => {
  vi.restoreAllMocks();
});

const TOKEN = "t".repeat(40);

function render(locale: SignerLocale, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={messages[locale]}
      timeZone="UTC"
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const view = (document: Partial<SigningView["document"]> = {}): SigningView => ({
  state: "completed",
  needsCode: false,
  needsConsent: false,
  consent: { text: "I agree.", version: "v1" },
  document: { title: "Merchant Agreement", reference: "SGN-1", pageCount: 2, locale: "en", expiresAt: null, message: null, signInOrder: false, codeRequired: false, ...document },
  workspace: { name: "Vircle", logoUrl: null },
  signer: { name: "Ali bin Ahmad", roleKey: "merchant", kind: "signer", status: "signed" },
  content: null,
});

/** The visible text of every link, with its address. */
const links = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((m) => ({ href: m[1].replace(/&amp;/g, "&"), text: m[2].replace(/<[^>]+>/g, "").trim() }));

describe("the screen of a signer whose document is complete", () => {
  for (const locale of LOCALES) {
    const w = WORDS[locale];

    it(`offers the signed document, the certificate and the zip, each at its own address (${locale})`, () => {
      const l = links(render(locale, <EndScreen state="completed" view={view({ hasCertificate: true })} token={TOKEN} canDownload />));
      const base = `/api/sign/public/${TOKEN}/file`;
      expect(l.find((x) => x.text === w.signed)?.href).toBe(`${base}?download=1`);
      expect(l.find((x) => x.text === w.certificate)?.href).toBe(`${base}?download=1&part=certificate`);
      expect(l.find((x) => x.text === w.all)?.href).toBe(`${base}?download=1&part=zip`);
      // the view link is the signed file as it always was
      expect(l.some((x) => x.href === base)).toBe(true);
      expect(errors).toEqual([]);
    });

    it(`says "record" for a form without a signature (${locale})`, () => {
      const l = links(render(locale, <EndScreen state="completed" view={view({ hasCertificate: true, mode: "form" })} token={TOKEN} canDownload />));
      expect(l.map((x) => x.text)).toEqual(expect.arrayContaining([w.record, w.certificate, w.all]));
      expect(l.map((x) => x.text)).not.toContain(w.signed);
    });

    it(`keeps the buttons a document sealed earlier had: its certificate is inside the signed PDF, so there is nothing more to offer (${locale})`, () => {
      const html = render(locale, <EndScreen state="completed" view={view()} token={TOKEN} canDownload />);
      const texts = links(html).map((x) => x.text);
      expect(texts).not.toContain(w.certificate);
      expect(texts).not.toContain(w.all);
      expect(html).not.toContain("part=");
      expect(links(html).some((x) => x.href === `/api/sign/public/${TOKEN}/file?download=1`)).toBe(true);
      if (w.old) expect(texts).toContain(w.old);
    });

    it(`offers none of the files before the code is entered (${locale})`, () => {
      const html = render(locale, <EndScreen state="completed" view={view({ hasCertificate: true, codeRequired: true })} token={TOKEN} canDownload={false} />);
      expect(html).not.toContain("download=1");
      expect(html).not.toContain("part=");
    });
  }

  it("gives a person handed only a part of someone's form nothing to download", () => {
    const html = render("en", <EndScreen state="completed" view={{ ...view({ hasCertificate: true }), delegate: true }} token={TOKEN} canDownload />);
    expect(html).not.toContain("download=1");
  });
});

describe("the end of a document collection's sitting", () => {
  const docs = (hasCertificate: [boolean, boolean, boolean], states: EnvelopeDocView["state"][] = ["completed", "completed", "completed"]): EnvelopeDocView[] =>
    [1, 2, 3].map((n) => ({ id: `d${n}`, position: n, title: `Document ${n}`, reference: `SGN-${n}`, pageCount: 1, mode: "sign" as const, state: states[n - 1], ...(hasCertificate[n - 1] ? { hasCertificate: true } : {}) }));
  const envelope = (over: Partial<EnvelopeView> = {}): EnvelopeView => ({ title: "Onboarding pack", reference: "COL-2026-000007", count: 3, current: "d1", state: "completed", documents: docs([true, true, true]), ...over });
  const end = (locale: SignerLocale, e: EnvelopeView, canDownload = true) => render(locale, <EnvelopeEnd envelope={e} scope={scopeOf(TOKEN, "d1")} name="Ali" canDownload={canDownload} />);

  for (const locale of LOCALES) {
    const w = WORDS[locale];
    it(`offers each document's signed file and certificate, and ONE zip of the whole collection (${locale})`, () => {
      const l = links(end(locale, envelope()));
      const base = `/api/sign/public/${TOKEN}/file`;
      for (const id of ["d1", "d2", "d3"]) {
        expect(l.some((x) => x.href === `${base}?doc=${id}&download=1`), id).toBe(true);
        expect(l.some((x) => x.href === `${base}?doc=${id}&download=1&part=certificate`), id).toBe(true);
      }
      const all = l.filter((x) => x.text === w.all);
      expect(all).toHaveLength(1);
      expect(all[0].href).toBe(`${base}?doc=d1&download=1&part=zip`);
      expect(l.filter((x) => x.text === w.certificate)).toHaveLength(3);
      expect(errors).toEqual([]);
    });
  }

  it("offers a certificate only for the documents that have one as a file of its own", () => {
    const l = links(end("en", envelope({ documents: docs([true, false, true]) })));
    expect(l.filter((x) => x.text === "Certificate").map((x) => x.href.match(/doc=(d\d)/)![1])).toEqual(["d1", "d3"]);
    // the zip is still the one download of the collection
    expect(l.filter((x) => x.text === "Download all (zip)")).toHaveLength(1);
  });

  it("offers no zip and no certificate while the collection is not finished, nor before the code is entered", () => {
    const sealing = end("en", envelope({ state: "sealing", documents: docs([false, false, false], ["sealing", "sealing", "sealing"]) }));
    expect(sealing).not.toContain("part=");
    expect(sealing).not.toContain("Download all (zip)");
    const waiting = end("en", envelope({ state: "signed", documents: docs([true, false, false], ["completed", "signed", "signed"]) }));
    expect(waiting).not.toContain("Download all (zip)");
    const locked = end("en", envelope(), false);
    expect(locked).not.toContain("download=1");
    expect(locked).not.toContain("part=");
  });
});
