import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import type { SignListRow } from "@/hooks/use-sign-documents";
import { envelopeToRow } from "@/lib/sign/client/list-merge";

import { PrivateBadge } from "./private-badge";
import { MetaLine } from "./list/row-parts";

// The lock of a private document (migration 176) in the list and on the detail screens, in every language with the real wording (next-intl throws on a
// missing key). It says "Private" in a word and, for a screen reader and as a tooltip, who can see the document.

type Tree = Record<string, unknown>;
const LOCALES = ["en", "ms", "zh", "ko"] as const;
const messages = (locale: string): Tree => JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as Tree;

function page(locale: string, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={messages(locale)}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const WORDS: Record<(typeof LOCALES)[number], { badge: string; title: string }> = {
  en: { badge: "Private", title: "only the person who uploaded it, the workspace&#x27;s admins and the people named as signers can see this" },
  ms: { badge: "Peribadi", title: "hanya orang yang memuat naik dokumen ini" },
  zh: { badge: "私密", title: "只有上传者、工作区管理员和被指定为签署人的人可以查看" },
  ko: { badge: "비공개", title: "업로드한 사람, 워크스페이스 관리자, 서명자로 지정된 사람만 볼 수 있습니다" },
};

const row = (over: Partial<SignListRow> = {}): SignListRow => ({
  id: "d1",
  reference: "SGN-2026-000001",
  title: "Agreement",
  status: "draft",
  category_id: null,
  contact_id: null,
  sign_in_order: false,
  sent_at: null,
  expires_at: null,
  completed_at: null,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  contacts: null,
  sign_signers: [],
  ...over,
});

describe("the lock of a private document", () => {
  for (const locale of LOCALES) {
    const w = WORDS[locale];
    it(`says Private in a word and who can see it in full, for a screen reader and as a tooltip (${locale})`, () => {
      const html = page(locale, <PrivateBadge />);
      expect(html).toContain("data-private-badge");
      expect(html).toContain(w.badge);
      expect(html).toContain(w.title);
      expect(html).toContain('title="');
      expect(html).toContain("sr-only");
      expect(html).toContain("lucide-lock");
      expect(html).not.toMatch(/private\.(badge|badgeTitle)/);
      expect(html.toLowerCase()).not.toContain("envelope");
    });

    it(`is in the list next to the reference of a private document, and only there (${locale})`, () => {
      const secret = page(locale, <MetaLine row={row({ is_private: true })} categories={[]} />);
      expect(secret).toContain("data-private-badge");
      expect(secret).toContain(w.badge);
      expect(secret).toContain("SGN-2026-000001");
      const open = page(locale, <MetaLine row={row()} categories={[]} />);
      expect(open).not.toContain("data-private-badge");
      expect(open).not.toContain(w.badge);
      // a private document with no reference still shows it
      expect(page(locale, <MetaLine row={row({ is_private: true, reference: null })} categories={[]} />)).toContain("data-private-badge");
    });
  }

  it("is on a private collection's row of the list too", () => {
    const raw = {
      id: "e1", reference: "COL-2026-000001", title: "Onboarding", status: "draft" as const, is_private: true, contact_id: null, sign_in_order: false, sent_at: null, expires_at: null, completed_at: null,
      created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z", contacts: null, sign_documents: [],
    };
    const asRow = envelopeToRow(raw);
    expect(asRow.is_private).toBe(true);
    expect(envelopeToRow({ ...raw, is_private: undefined }).is_private).toBe(false);
    const html = page("en", <MetaLine row={asRow as unknown as SignListRow} categories={[]} />);
    expect(html).toContain("data-private-badge");
    expect(html).toContain("COL-2026-000001");
  });
});
