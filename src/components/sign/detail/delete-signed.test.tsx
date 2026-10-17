import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// Deleting a signed document or document collection once its retention date has passed. The decisions are pure and tested first; then the header button
// and the confirmation dialog are rendered in every language with the real wording (next-intl is told to throw on a missing key or argument).
// Effects and clicks do not run under renderToStaticMarkup: the request itself is the route's (service/retention.test.ts and envelope-flow.test.ts).

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

import { Dialog } from "@/components/ui/dialog";
import type { SignDocumentRow } from "@/lib/sign/types";

import { DeleteBody } from "./delete-dialog";
import { DetailHeader } from "./detail-header";
import { canDeleteSigned, canDeleteSignedCollection, deleteRefusalReason, documentActions, latestRetention } from "./logic";

const NOW = new Date("2026-10-17T08:00:00Z");
const ENDED = "2026-10-06T08:00:00Z";
const AHEAD = "2033-10-06T08:00:00Z";
const yes = { settings: true };
const no = { settings: false };

describe("canDeleteSigned", () => {
  it("offers Delete to someone with sign.settings, for a signed document whose retention date has passed", () => {
    expect(canDeleteSigned({ status: "completed", retain_until: ENDED }, yes, NOW)).toBe(true);
    // on the very instant, as the banner and the server count it
    expect(canDeleteSigned({ status: "completed", retain_until: NOW.toISOString() }, yes, NOW)).toBe(true);
  });

  it("offers nothing to anyone without sign.settings", () => {
    expect(canDeleteSigned({ status: "completed", retain_until: ENDED }, no, NOW)).toBe(false);
  });

  it("offers nothing before the date, one second before it, or without a date (kept, to be safe), or for an unreadable date", () => {
    expect(canDeleteSigned({ status: "completed", retain_until: AHEAD }, yes, NOW)).toBe(false);
    expect(canDeleteSigned({ status: "completed", retain_until: "2026-10-17T08:00:01Z" }, yes, NOW)).toBe(false);
    expect(canDeleteSigned({ status: "completed", retain_until: null }, yes, NOW)).toBe(false);
    expect(canDeleteSigned({ status: "completed" }, yes, NOW)).toBe(false);
    expect(canDeleteSigned({ status: "completed", retain_until: "not a date" }, yes, NOW)).toBe(false);
  });

  it("offers nothing for a document that is not signed: a draft is deleted from its own screen, the rest are cancelled", () => {
    for (const status of ["draft", "sent", "in_progress", "sealing", "declined", "expired", "voided", "failed"]) {
      expect(canDeleteSigned({ status, retain_until: ENDED }, yes, NOW), status).toBe(false);
    }
  });

  it("treats a document cancelled after completion like any signed one (its status stays completed, its date is unchanged)", () => {
    const cancelled = { status: "completed", retain_until: ENDED, cancelled_at: "2026-09-01T00:00:00Z" };
    expect(canDeleteSigned(cancelled, yes, NOW)).toBe(true);
    expect(canDeleteSigned({ ...cancelled, retain_until: AHEAD }, yes, NOW)).toBe(false);
  });
});

describe("canDeleteSignedCollection", () => {
  const docs = (...dates: (string | null)[]) => dates.map((retainUntil) => ({ status: "completed", retainUntil }));

  it("offers Delete only when every document is signed and past its date, to someone with sign.settings", () => {
    expect(canDeleteSignedCollection({ status: "completed", documents: docs(ENDED, "2026-01-01T00:00:00Z") }, yes, NOW)).toBe(true);
    expect(canDeleteSignedCollection({ status: "completed", documents: docs(ENDED, "2026-01-01T00:00:00Z") }, no, NOW)).toBe(false);
  });

  it("offers nothing while any one document is still kept, has no date, or is not signed", () => {
    expect(canDeleteSignedCollection({ status: "completed", documents: docs(ENDED, AHEAD) }, yes, NOW)).toBe(false);
    expect(canDeleteSignedCollection({ status: "completed", documents: docs(ENDED, null) }, yes, NOW)).toBe(false);
    expect(canDeleteSignedCollection({ status: "completed", documents: [...docs(ENDED), { status: "failed", retainUntil: ENDED }] }, yes, NOW)).toBe(false);
  });

  it("offers nothing for a collection that is not completed, or has no documents", () => {
    for (const status of ["draft", "sent", "in_progress", "sealing", "declined", "expired", "voided", "failed"]) {
      expect(canDeleteSignedCollection({ status, documents: docs(ENDED) }, yes, NOW), status).toBe(false);
    }
    expect(canDeleteSignedCollection({ status: "completed", documents: [] }, yes, NOW)).toBe(false);
  });
});

describe("latestRetention", () => {
  it("is the last of the dates, and null when there is none", () => {
    expect(latestRetention([{ retainUntil: "2026-01-01T00:00:00Z" }, { retainUntil: ENDED }, { retainUntil: null }, {}])).toBe(ENDED);
    expect(latestRetention([{ retainUntil: null }, {}])).toBeNull();
    expect(latestRetention([])).toBeNull();
    expect(latestRetention([{ retainUntil: "not a date" }])).toBeNull();
  });
});

describe("deleteRefusalReason", () => {
  it("passes on the server's own words for a refusal (retention not over, no permission, not found, changed meanwhile)", () => {
    expect(deleteRefusalReason({ status: 409, message: " This signed document is kept until 2033-10-06 and cannot be deleted before then. " })).toBe("This signed document is kept until 2033-10-06 and cannot be deleted before then.");
    expect(deleteRefusalReason({ status: 403, message: "You do not have permission to do that." })).toBe("You do not have permission to do that.");
    expect(deleteRefusalReason({ status: 404, message: "That document was not found." })).toBe("That document was not found.");
  });

  it("leaves a failure that is not a refusal to the screen's own sentence", () => {
    expect(deleteRefusalReason({ status: 0, message: "Could not reach the server." })).toBeNull();
    expect(deleteRefusalReason({ status: 500, message: "Request failed (500)" })).toBeNull();
    expect(deleteRefusalReason({ status: 409, message: "  " })).toBeNull();
    expect(deleteRefusalReason(null)).toBeNull();
  });
});

// ---- the screens ----------------------------------------------------------------------------

const LOCALES = ["en", "ms", "zh", "ko"] as const;
type Locale = (typeof LOCALES)[number];
type Tree = Record<string, unknown>;
const catalogue = (locale: string): Tree => JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as Tree;
const CATALOGUES = Object.fromEntries(LOCALES.map((l) => [l, catalogue(l)])) as Record<Locale, Tree>;
const wording = (locale: Locale) => (CATALOGUES[locale] as { Sign: { detail: { delete: Record<string, string> } } }).Sign.detail.delete;

function page(locale: Locale, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={CATALOGUES[locale] as never}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}
const inDialog = (node: React.ReactNode) => (
  <Dialog open onOpenChange={() => undefined}>
    {node}
  </Dialog>
);

const signed = { id: "d1", reference: "SGN-2026-000123", title: "Merchant Agreement", status: "completed", mode: "sign", final_path: "f", base_path: "b", original_path: "o", certificate_path: null, retain_until: ENDED, created_at: "2026-01-01T00:00:00Z", completed_at: "2026-01-02T00:00:00Z" } as unknown as SignDocumentRow;
const noop = () => undefined;
/** The text as renderToStaticMarkup writes it (an apostrophe becomes an entity). */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

function header(locale: Locale, onDelete?: () => void) {
  return page(locale, <DetailHeader document={signed} links={{ category: null, contact: null, ticket: null, deal: null }} actions={documentActions(signed, { void: false })} downloading={null} onView={noop} onDownload={noop} onVoid={noop} onDelete={onDelete} />);
}

describe("the Delete button in the header", () => {
  for (const locale of LOCALES) {
    it(`shows only when the screen gives it an action (${locale})`, () => {
      const label = `>${esc(wording(locale).open)}<`;
      expect(header(locale, noop)).toContain(label);
      expect(header(locale)).not.toContain(label);
    });
  }
});

describe("the confirmation dialog", () => {
  const body = (locale: Locale, target: React.ComponentProps<typeof DeleteBody>["target"], reference: string | null = "SGN-2026-000123") =>
    page(locale, inDialog(<DeleteBody target={target} reference={reference} title="Merchant Agreement" retainUntil={ENDED} onClose={noop} busy={false} setBusy={noop} />));

  for (const locale of LOCALES) {
    const w = wording(locale);

    it(`${locale}: says what goes and that it cannot be undone, shows the reference, and asks with a destructive Delete button (no typing)`, () => {
      const html = body(locale, { kind: "document", id: "d1" });
      expect(html).toContain(esc(w.title));
      expect(html).toContain(esc(w.body));
      expect(html).toContain(esc(w.warning));
      expect(html).toContain("Merchant Agreement");
      expect(html).toContain(esc(w.reference.replace("{reference}", "SGN-2026-000123")));
      // the retention date it was kept until, in the reader's language
      expect(html).toContain(esc(w.retentionEnded.split("{date}")[0].trim()));
      expect(html).toContain("2026");
      expect(html).toContain(esc(w.keep));
      expect(html).toContain(esc(w.action));
      // a destructive Delete button that submits, and no field to type a confirmation into
      expect(html.match(/<button[^>]*type="submit"[^>]*>/)?.[0]).toContain("bg-destructive/10 text-destructive");
      expect(html).not.toMatch(/<input|<textarea/);
      expect(html).not.toContain('role="alert"');
    });

    it(`${locale}: a collection names the collection and how many documents go with it`, () => {
      const html = body(locale, { kind: "collection", id: "e1", documents: 3 }, "COL-2026-000007");
      expect(html).toContain(esc(w.titleCollection));
      expect(html).not.toContain(esc(w.title));
      expect(html).toContain("COL-2026-000007");
      expect(html).toContain("3");
      expect(html).not.toContain("{count}");
    });

    it(`${locale}: never says envelope or Doc Sign`, () => {
      const all = [w.title, w.titleCollection, w.body, w.bodyCollection, w.warning, w.keep, w.action, w.open, w.failed, w.done].join(" ");
      expect(all).not.toMatch(/envelope|Doc Sign/i);
    });
  }
});
