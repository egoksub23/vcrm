import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// Render tests for the two shortcuts of the documents list and the sidebar badge, in every language with the real
// wording; next-intl throws on a missing key or argument instead of printing a raw key path. The words are read from the
// merged message files. Until the fragments of work package 15 are merged into them, set SIGN_I18N_FRAGMENTS to the folder
// that holds send-wp15.json to run the same checks against the fragment.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));

import { COUNTERSIGN_ERROR_CODES, type AttentionItem, type AwaitingItem } from "@/lib/sign/client/countersign";
import { AwaitingBadge } from "../awaiting-badge";
import { AttentionPanel, AwaitingPanel, ShortcutBar } from "./shortcut-panels";

type Tree = Record<string, unknown>;

function wording(locale: string): Tree | null {
  const file = join(process.cwd(), "messages", `${locale}.json`);
  const merged = existsSync(file) ? ((JSON.parse(readFileSync(file, "utf8")) as { Sign?: { send?: { list?: Tree } } }).Sign?.send?.list ?? {}) : {};
  if ((merged as Tree).awaiting) return merged;
  const dir = process.env.SIGN_I18N_FRAGMENTS;
  const fragment = dir && existsSync(join(dir, "send-wp15.json")) ? (JSON.parse(readFileSync(join(dir, "send-wp15.json"), "utf8")) as Record<string, { list?: Tree }>)[locale]?.list : null;
  return fragment ? { ...merged, ...fragment } : null;
}
const LOCALES = ["en", "ms", "zh", "ko"].filter((l) => wording(l) !== null);

function page(locale: string, node: React.ReactNode) {
  // the screens' own existing keys (loading, loadFailed, retry) are not part of this package: a stand-in
  const list = { loading: "Loading", loadFailed: "Failed", retry: "Retry", ...wording(locale) };
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={{ Sign: { send: { list } } }}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const awaiting = (over: Partial<AwaitingItem> = {}): AwaitingItem => ({ documentId: "d1", signerId: "s1", title: "Merchant Agreement", reference: "SIGN-2026-0007", roleLabel: "Director", senderName: "Gokula", sentAt: "2026-10-04T09:00:00Z", expiresAt: "2026-10-18T09:00:00Z", step: null, ...over });
const attention = (over: Partial<AttentionItem> = {}): AttentionItem => ({ documentId: "d2", title: "Lease", reference: "SIGN-2026-0008", status: "sent", reasons: ["undelivered"], people: ["Ali", "Siti"], at: "2026-10-05T09:00:00Z", ...over });
const state = { loading: false, failed: false, reload: () => undefined };

describe.skipIf(LOCALES.length === 0)("the shortcuts of the documents list", () => {
  for (const locale of LOCALES) {
    describe(locale, () => {
      it("shows the two shortcut tabs with their counts, and only the second to someone who may not countersign", () => {
        const both = page(locale, <ShortcutBar view="documents" onView={() => undefined} showAwaiting awaitingCount={3} attentionCount={2} />);
        expect(both).toContain(">3<");
        expect(both).toContain(">2<");
        expect(both.match(/aria-pressed="false"/g)).toHaveLength(2);
        const one = page(locale, <ShortcutBar view="attention" onView={() => undefined} showAwaiting={false} awaitingCount={0} attentionCount={2} />);
        expect(one.match(/<button/g)).toHaveLength(1);
        expect(one).toContain('aria-pressed="true"');
      });

      it("lists what waits for my signature with Sign now, who sent it, when and the step", () => {
        const html = page(locale, <AwaitingPanel items={[awaiting(), awaiting({ signerId: "s2", documentId: "d9", step: 2, senderName: null })]} {...state} />);
        expect(html).toContain("Merchant Agreement");
        expect(html).toContain("SIGN-2026-0007");
        expect(html).toContain('href="/sign/d1"');
        expect(html.match(/<button/g)).toHaveLength(2);
        expect(html).not.toMatch(/Sign\.send|\.awaiting\./);
      });

      it("says so when nothing is waiting, when it is loading, and when it could not be read", () => {
        expect(page(locale, <AwaitingPanel items={[]} {...state} />)).not.toContain("<button");
        expect(page(locale, <AwaitingPanel items={[]} {...state} loading />)).toContain('role="status"');
        expect(page(locale, <AwaitingPanel items={[]} {...state} failed />)).toContain('role="alert"');
        // a failed refresh keeps showing what was already there
        expect(page(locale, <AwaitingPanel items={[awaiting()]} {...state} failed />)).toContain("Merchant Agreement");
      });

      it("lists what needs attention with why and who it is about", () => {
        const html = page(locale, <AttentionPanel items={[attention(), attention({ documentId: "d3", title: "Declined deal", status: "declined", reasons: ["declined"], people: ["Lim"] }), attention({ documentId: "d4", title: "Broken seal", status: "failed", reasons: ["failed"], people: [] })]} {...state} />);
        expect(html).toContain("Lease");
        expect(html).toContain("Declined deal");
        expect(html).toContain("Broken seal");
        expect(html).toContain('href="/sign/d2"');
        expect(html).toContain("Ali");
        expect(html).toContain("Lim");
        expect(page(locale, <AttentionPanel items={[]} {...state} />)).not.toContain('href="/sign/');
      });

      it("shows the sidebar badge with the count, nothing at zero and 9+ from ten", () => {
        expect(page(locale, <AwaitingBadge count={4} />)).toContain("data-sign-awaiting-badge");
        expect(page(locale, <AwaitingBadge count={4} />)).toContain(">4<");
        expect(page(locale, <AwaitingBadge count={0} />)).toBe("");
        expect(page(locale, <AwaitingBadge count={12} />)).toContain(">9+<");
      });

      it("has words for every refusal of Sign now, and a generic one", () => {
        const errors = ((wording(locale) as { awaiting: { errors: Record<string, string> } }).awaiting.errors);
        for (const code of [...COUNTERSIGN_ERROR_CODES, "generic"]) expect(errors[code], `${locale}.${code}`).toEqual(expect.any(String));
      });
    });
  }
});
