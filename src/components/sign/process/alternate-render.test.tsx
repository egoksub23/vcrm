import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// The People step with someone who can sign instead of a person (migration 187), with the real wording in every language (next-intl throws on a missing
// key or argument): the small "add" button on a person who must sign (a document on its own only, never a person who receives a copy, a Halo user, or a
// collection), and the box with a name and an address once it is added.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "acc-1" }) }));
vi.mock("@/hooks/use-account-members", () => ({ useAccountMembers: () => ({ members: [], nameOf: () => "", profileOf: () => undefined }) }));
vi.mock("../send/person-name-input", () => ({ PersonNameInput: (p: { id?: string; value: string }) => <input data-name-box id={p.id} role="combobox" aria-controls="x" aria-expanded={false} defaultValue={p.value} /> }));

import { liteDocs } from "@/lib/sign/client/process";
import type { EnvelopePerson } from "@/lib/sign/envelopes";
import { ProcessPeople } from "./people-step";
import { person, processDoc, role } from "./test-support";

type Tree = Record<string, unknown>;
const LOCALES = ["en", "ms", "zh", "ko"] as const;
const wording = (locale: string): Tree => (JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as { Sign: Tree }).Sign;

function page(locale: string, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={{ Sign: wording(locale) }}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const ALI = "pp_aliaaaa1";
const BALA = "pp_balabbbb2";
const SITI = { fullName: "Siti Finance", email: "siti@kedai.example" };
const ali = (over: Partial<EnvelopePerson> = {}) => person(ALI, "Ali", over);
const bala = (over: Partial<EnvelopePerson> = {}) => person(BALA, "Bala", { step: 2, ...over });
const cara = () => person("pp_cara0001", "Cara", { type: "copy" });

const upload = (who: EnvelopePerson[]) => {
  const signers = who.filter((p) => (p.type ?? "signer") === "signer");
  return processDoc(1, { roles: signers.map((p, i) => ({ ...role(p.key, p.fullName, i), source: "people" as const })), signatureCounts: Object.fromEntries(signers.map((p) => [p.key, 1])), fieldCounts: Object.fromEntries(signers.map((p) => [p.key, 1])), rolesNeeded: signers.map((p) => p.key) });
};

const props = { ordered: false, readOnly: false, showInvalid: false, whatsappConfigured: true as boolean | null, onPeople: () => {}, onOrdered: () => {} };
const render = (locale: string, who: EnvelopePerson[], over: Partial<React.ComponentProps<typeof ProcessPeople>> = {}) => {
  const docs = [upload(who)];
  return page(locale, <ProcessPeople kind="single" docs={liteDocs(docs)} workDocs={docs} people={who} {...props} {...over} />);
};

const ADD: Record<(typeof LOCALES)[number], string> = {
  en: "Add someone who can sign instead",
  ms: "Tambah orang yang boleh menandatangani sebagai ganti",
  zh: "添加可代为签署的人",
  ko: "대신 서명할 수 있는 사람 추가",
};
const HINT: Record<(typeof LOCALES)[number], string> = {
  en: "Both get their own link at the same time. Whoever completes it first signs for Ali",
  ms: "Kedua-duanya mendapat pautan masing-masing pada masa yang sama.",
  zh: "两个人同时各收到自己的链接。谁先完成，谁就代表 Ali 签署",
  ko: "두 사람이 동시에 각자의 링크를 받습니다.",
};

describe("the People step and someone who can sign instead", () => {
  for (const locale of LOCALES) {
    it(`offers it on each person who must sign, and shows the box once it is added (${locale})`, () => {
      const without = render(locale, [ali(), bala(), cara()]);
      expect(without.match(new RegExp(ADD[locale], "g"))).toHaveLength(2); // Ali and Bala, not Cara who receives a copy
      expect(without).not.toContain("data-alternate-box");

      const withOne = render(locale, [ali({ alternate: SITI }), bala(), cara()]);
      expect(withOne.match(/data-alternate-box/g)).toHaveLength(1);
      expect(withOne).toContain(HINT[locale]);
      expect(withOne.match(new RegExp(ADD[locale], "g"))).toHaveLength(1); // only Bala is left to offer it to
      expect(withOne).toContain(`id="${ALI}-alt-name"`);
      expect(withOne).toContain(`id="${ALI}-alt-email"`);
      expect(withOne).toContain('value="Siti Finance"');
      expect(withOne).toContain('value="siti@kedai.example"');
    });
  }

  it("marks a half typed alternate once it is typed in or the review was asked for", () => {
    const quiet = render("en", [ali({ alternate: { fullName: "", email: "" } })]);
    expect(quiet).not.toContain('aria-invalid="true"');
    const typed = render("en", [ali({ alternate: { fullName: "Siti", email: "siti@" } })]);
    expect(typed).toContain("Enter a valid email address");
    const asked = render("en", [ali({ alternate: { fullName: "", email: "" } })], { showInvalid: true });
    expect(asked).toContain("Enter a full name.");
  });

  it("does not offer it for a Halo user, for a collection, for a person who receives a copy, or when the screen is read only", () => {
    const halo = render("en", [ali({ internalUserId: "33333333-3333-4333-8333-333333333333" })]);
    expect(halo).not.toContain(ADD.en);
    const docs = [upload([ali()]), { ...upload([ali()]), id: "doc-2" }];
    const collection = page("en", <ProcessPeople kind="collection" docs={liteDocs(docs)} workDocs={docs} people={[ali()]} {...props} />);
    expect(collection).not.toContain(ADD.en);
    expect(collection).not.toContain("data-alternate-box");
    expect(render("en", [cara()])).not.toContain(ADD.en);
    const locked = render("en", [ali({ alternate: SITI })], { readOnly: true });
    expect(locked).toMatch(/<input[^>]*id="pp_aliaaaa1-alt-name"[^>]*disabled/);
  });

  it("takes the choose-a-Halo-user button away while someone can sign instead", () => {
    expect(render("en", [ali()])).toContain("Choose a Halo user");
    const withAlt = render("en", [ali({ alternate: SITI })]);
    expect(withAlt).not.toContain("Choose a Halo user");
  });
});
