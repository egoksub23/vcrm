import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// A Halo user on the People step of a document on its own, in every language with the real wording (next-intl throws on a missing key). The
// words come from the merged message files. A document collection offers no Halo user (a countersigner signs a document on its own).

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
// the name box searches the workspace's contacts; here it only shows what it was given
vi.mock("./person-name-input", () => ({
  PersonNameInput: (p: { id?: string; value: string; readOnly?: boolean }) => <input data-name-box id={p.id} role="combobox" aria-controls="x" aria-expanded={false} defaultValue={p.value} readOnly={p.readOnly} />,
}));

import type { EnvelopeDocLite, EnvelopePerson } from "@/lib/sign/envelopes";
import { ProcessPeople } from "../process/people-step";
import { HaloUserPicker } from "./halo-user-picker";

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

const uploaded: EnvelopeDocLite = { id: "d1", position: 1, title: "Scanned contract", roles: [], fromTemplate: false };
const person = (over: Partial<EnvelopePerson> = {}): EnvelopePerson => ({ key: "pp_aaaaaaaa", fullName: "Ali", email: "ali@example.com", phone: "", channel: "email", step: 1, roles: {}, ...over });
const halo = (): EnvelopePerson => person({ fullName: "Gokula Krishnan", email: "gokula@vircle.example", internalUserId: "u-gokula" });
const render = (locale: string, people: EnvelopePerson[], kind: "single" | "collection" = "single") =>
  page(locale, <ProcessPeople kind={kind} docs={[uploaded]} people={people} ordered={false} readOnly={false} showInvalid={false} whatsappConfigured onPeople={() => {}} onOrdered={() => {}} />);

const WORDS: Record<string, { choose: string; tag: string; letGo: string }> = {
  en: { choose: "Choose a Halo user", tag: "Halo user", letGo: "Use someone outside Halo instead" },
  ms: { choose: "Pilih pengguna Halo", tag: "Pengguna Halo", letGo: "Guna orang di luar Halo sebaliknya" },
  zh: { choose: "选择 Halo 用户", tag: "Halo 用户", letGo: "改用 Halo 以外的人" },
  ko: { choose: "Halo 사용자 선택", tag: "Halo 사용자", letGo: "대신 Halo 밖의 사람 사용" },
};

describe.skipIf(LOCALES.length === 0)("a Halo user on the People step", () => {
  for (const locale of LOCALES) {
    it(`an ordinary person offers the choice, and no Halo mark (${locale})`, () => {
      const html = render(locale, [person()]);
      expect(html).toContain(WORDS[locale].choose);
      expect(html).not.toContain("data-halo-user");
      expect(html).not.toContain("readOnly");
    });

    it(`a Halo user is marked, with name and email not typed, and a way to let go (${locale})`, () => {
      const html = render(locale, [halo()]);
      expect(html).toContain("data-halo-user");
      expect(html).toContain(`</svg>${WORDS[locale].tag}</span>`);
      expect(html).not.toContain(WORDS[locale].choose);
      expect(html).toContain("Gokula Krishnan");
      expect(html.match(/readOnly=""/g)).toHaveLength(2);
      expect(html).toContain(WORDS[locale].letGo);
    });

    it(`a person who receives a copy, and a document collection, offer no Halo user (${locale})`, () => {
      expect(render(locale, [person({ type: "copy" })])).not.toContain(WORDS[locale].choose);
      const collection = render(locale, [person()], "collection");
      expect(collection).not.toContain(WORDS[locale].choose);
      expect(collection).not.toContain("data-halo-user");
    });

    it(`the picker lists the members, and leaves out one already on the list (${locale})`, () => {
      const html = page(locale, <HaloUserPicker rows={[halo()]} onPick={() => {}} />);
      expect(html).toContain("Siti Aminah");
      expect(html).not.toContain("Gokula Krishnan");
    });
  }
});
