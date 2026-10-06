import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// A Halo user on the people step, in every language with the real wording (next-intl throws on a missing key). The words come
// from the merged message files; the tests wait for them to be merged.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("@/hooks/use-account-members", () => ({
  useAccountMembers: () => ({
    members: [
      { id: "p1", user_id: "u-gokula", full_name: "Gokula Krishnan", email: "gokula@vircle.example", role: "", created_at: "" },
      { id: "p2", user_id: "u-siti", full_name: "Siti Aminah", email: "siti@vircle.example", role: "", created_at: "" },
    ],
    nameOf: () => "",
    profileOf: () => undefined,
  }),
}));

import { asHaloUser, emptyRow, type SignerRow } from "@/lib/sign/client/signers-form";
import type { SignRole } from "@/lib/sign/types";
import { HaloUserPicker } from "./halo-user-picker";
import { SignerRowEditor } from "./signer-row";

type Tree = Record<string, unknown>;
function wording(locale: string): Tree | null {
  const file = join(process.cwd(), "messages", `${locale}.json`);
  if (!existsSync(file)) return null;
  const sign = (JSON.parse(readFileSync(file, "utf8")) as { Sign?: Tree & { send?: Tree & { people?: Tree } } }).Sign;
  return (sign?.send?.people as Tree | undefined)?.haloUserTag ? (sign as Tree) : null;
}
const LOCALES = ["en", "ms", "zh", "ko"].filter((l) => wording(l) !== null);

function page(locale: string, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={{ Sign: wording(locale)! }}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const roles: SignRole[] = [{ key: "director", label: "Director", kind: "signer", color: 1 }];
const handlers = { onChange: () => {}, onRemove: () => {}, onMove: () => {}, onStep: () => {}, onDragStart: () => {}, onDragOver: () => {}, onDrop: () => {}, onDragEnd: () => {} };
const row = (over: Partial<SignerRow> = {}): SignerRow => ({ ...emptyRow("director", 1), fullName: "Ali", email: "ali@example.com", ...over });
const renderRow = (locale: string, r: SignerRow, onChooseHalo?: () => void) =>
  page(locale, <ul><SignerRowEditor row={r} index={0} count={1} roles={roles} ordered={false} showInvalid={false} whatsappConfigured notice={null} dragging={false} dropTarget={false} onChooseHalo={onChooseHalo} {...handlers} /></ul>);

const WORDS: Record<string, { choose: string; tag: string; letGo: string }> = {
  en: { choose: "Choose a Halo user", tag: "Halo user", letGo: "Use someone outside Halo instead" },
  ms: { choose: "Pilih pengguna Halo", tag: "Pengguna Halo", letGo: "Guna orang di luar Halo sebaliknya" },
  zh: { choose: "选择 Halo 用户", tag: "Halo 用户", letGo: "改用 Halo 以外的人" },
  ko: { choose: "Halo 사용자 선택", tag: "Halo 사용자", letGo: "대신 Halo 밖의 사람 사용" },
};

describe.skipIf(LOCALES.length === 0)("a Halo user on the people step", () => {
  for (const locale of LOCALES) {
    it(`an ordinary row offers the choice, and no Halo mark (${locale})`, () => {
      const html = renderRow(locale, row(), () => {});
      expect(html).toContain(WORDS[locale].choose);
      expect(html).not.toContain("data-halo-user");
      expect(html).not.toContain("readOnly");
    });

    it(`a Halo user's row is marked, with name and email not typed, and a way to let go (${locale})`, () => {
      const html = renderRow(locale, { ...row(), ...asHaloUser({ user_id: "u-gokula", full_name: "Gokula Krishnan", email: "gokula@vircle.example" }) }, () => {});
      expect(html).toContain("data-halo-user");
      expect(html).toContain(`</svg>${WORDS[locale].tag}</span>`);
      expect(html).not.toContain(WORDS[locale].choose);
      expect(html).toContain("Gokula Krishnan");
      expect(html.match(/readOnly=""/g)).toHaveLength(2);
      expect(html).toContain(WORDS[locale].letGo);
    });

    it(`a row without the handler (nowhere to choose from) shows neither (${locale})`, () => {
      const html = renderRow(locale, row());
      expect(html).not.toContain(WORDS[locale].choose);
      expect(html).not.toContain("data-halo-user");
    });

    it(`the picker lists the members, and leaves out one already on the list (${locale})`, () => {
      const taken = { ...row(), ...asHaloUser({ user_id: "u-gokula", full_name: "Gokula Krishnan", email: "gokula@vircle.example" }) };
      const html = page(locale, <HaloUserPicker rows={[taken]} onPick={() => {}} />);
      expect(html).toContain("Siti Aminah");
      expect(html).not.toContain("Gokula Krishnan");
    });
  }
});
