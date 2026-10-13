import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What the staff see about whose bank account the payout goes to (migration 186), in every language with the real wording from messages/<locale>.json:
// the calm "check before paying" note (answer Yes, names differ), the third-party note with a link to the authorization letter (answer No), the
// "Not asked (older form)" row of a case made before the question, and the Files panel listing the letter only while it is asked. renderToStaticMarkup
// paints the first render only. NOT covered (no DOM renderer): clicking the link, the Files panel's upload buttons, and editing the answer.

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "u1", email: "officer@example.test" }, profile: { full_name: "Olivia Officer", email: "officer@example.test" }, capabilities: new Set(["menu.compliance"]), refreshCapabilities: () => undefined }),
  useCapability: () => true,
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

import { bankFlagList, bankFlags, bankOwner, nameDiffersFlag } from "@/lib/compliance/bank-own";
import { expectedFileFields } from "@/lib/compliance/fields";
import { typeFromRow } from "@/lib/compliance/service/rows";
import { CLOSURE_FIELDS, TYPE_ROWS, withBankOwn } from "@/lib/compliance/test-support";
import type { RequestDetail, RequestFile, Viewer } from "@/lib/compliance/types";

import { AnswersPanel, BankFlags, FilesPanel } from "./detail-panels";

const LOCALES = ["en", "ms", "zh", "ko"] as const;
type Locale = (typeof LOCALES)[number];
type Tree = Record<string, unknown>;

const CATALOGUES = Object.fromEntries(LOCALES.map((l) => [l, JSON.parse(readFileSync(join(process.cwd(), "messages", `${l}.json`), "utf8")) as Tree])) as Record<Locale, Tree>;
const tr = (locale: Locale, namespace: string) => createTranslator({ locale, messages: CATALOGUES[locale] as never, namespace: namespace as never }) as unknown as (key: string) => string;

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => vi.restoreAllMocks());

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
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");
const noop = async () => true;
const NOW = Date.parse("2026-10-12T12:00:00Z");

const type186 = typeFromRow({ ...TYPE_ROWS[0], fields: withBankOwn(CLOSURE_FIELDS) });
const typeOld = typeFromRow(TYPE_ROWS[0]);
const viewer = (over: Partial<Viewer> = {}): Viewer => ({ userId: "u1", canReview: true, canApprove: false, canReveal: false, canExecute: false, canManage: false, ...over });
const letter: RequestFile = { id: "f1", name: "letter-from-owner.pdf", mime: "application/pdf", size: 52_000, fieldKey: "authorization_letter", uploadedBy: null, uploadedAt: "2026-10-09T10:00:00Z" };

const detail = (over: Partial<RequestDetail> = {}): RequestDetail =>
  ({
    id: "r1",
    reference: "CMP-2026-000014",
    typeKey: "closure",
    typeLabel: "Account closure",
    typeLabelL10n: {},
    status: "officer_review",
    customerName: "Siti Aminah",
    customerEmail: "siti@example.test",
    customerPhone: "+60123456789",
    receivedAt: "2026-10-04T12:00:00Z",
    targetDays: 14,
    hardStopDays: 30,
    targetDueAt: null,
    hardStopAt: null,
    pausedAt: null,
    completedAt: null,
    closedAt: null,
    assignedTo: null,
    source: "form",
    isTest: false,
    channel: "web_form",
    customerLocale: null,
    emailVerifiedAt: null,
    notices: [],
    type: type186,
    data: { confirm_closure: true, children_finished_school: true, allowances_cancelled: true, reason: "Moving abroad" },
    sensitive: [],
    sensitiveReadable: true,
    identityCheck: {},
    review: {},
    signoff: {},
    standing: { duesOutstanding: null },
    outcomeReason: null,
    decidedAt: null,
    retentionUntil: "2033-10-04T00:00:00Z",
    links: { contact: null, conversationId: null, ticket: null, incident: null, kycValidationRef: null },
    checklist: [],
    files: [],
    events: [],
    formLinks: [],
    createdBy: null,
    viewer: viewer(),
    ...over,
  }) as RequestDetail;
const props = (d: RequestDetail) => ({ d, act: noop, busy: false, now: NOW });

describe("the helpers behind the staff notes", () => {
  it("reads the answer: Yes is own, No is a third party, anything else was not asked", () => {
    expect(bankOwner({ bank_account_is_own: true })).toBe("own");
    expect(bankOwner({ bank_account_is_own: false })).toBe("third_party");
    expect(bankOwner({})).toBe("not_asked");
    expect(bankOwner(null)).toBe("not_asked");
    expect(bankOwner({ bank_account_is_own: "yes" })).toBe("not_asked");
  });

  it("flags a name difference only for an own account, and never for an older case", () => {
    expect(bankFlags({ bank_account_is_own: true, name_differs: true })).toEqual({ owner: "own", nameDiffers: true });
    expect(bankFlags({ bank_account_is_own: true, name_differs: false })).toEqual({ owner: "own", nameDiffers: false });
    expect(bankFlags({ bank_account_is_own: false, name_differs: true })).toEqual({ owner: "third_party", nameDiffers: false });
    expect(bankFlags({ name_differs: true })).toEqual({ owner: "not_asked", nameDiffers: false });
  });

  it("lists the notes: a difference alone, a third party with its letter, a third party whose letter is missing, nothing otherwise", () => {
    expect(bankFlagList({ bank_account_is_own: true, name_differs: true }, [])).toEqual([{ kind: "name_differs" }]);
    expect(bankFlagList({ bank_account_is_own: false }, [letter])).toEqual([{ kind: "third_party", file: { id: "f1", name: "letter-from-owner.pdf" } }]);
    expect(bankFlagList({ bank_account_is_own: false }, [{ ...letter, fieldKey: "proof" }])).toEqual([{ kind: "third_party", file: null }]);
    expect(bankFlagList({ bank_account_is_own: true, name_differs: false }, [letter])).toEqual([]);
    expect(bankFlagList({}, [])).toEqual([]);
  });

  it("writes the flag from the answer and the two names, and nothing when there is nothing to compare", () => {
    expect(nameDiffersFlag({ bank_account_is_own: true }, { bank_account_holder: "Ahmad Yusof" }, "Siti Aminah")).toBe(true);
    expect(nameDiffersFlag({ bank_account_is_own: true }, { bank_account_holder: "Gokula Krishnan a/l Subramaniam" }, "Gokula Krishnan Subramaniam")).toBe(false);
    expect(nameDiffersFlag({ bank_account_is_own: false }, { bank_account_holder: "Ahmad Yusof" }, "Siti Aminah")).toBe(false);
    expect(nameDiffersFlag({}, { bank_account_holder: "Ahmad Yusof" }, "Siti Aminah")).toBeNull();
    expect(nameDiffersFlag({ bank_account_is_own: true }, {}, "Siti Aminah")).toBeNull();
    expect(nameDiffersFlag({ bank_account_is_own: true }, { bank_account_holder: "  " }, "Siti Aminah")).toBeNull();
  });

  it("expects the letter only while the bank account is somebody else's, and keeps it listed for a case that was never asked", () => {
    const keys = (answers: Record<string, unknown>) => expectedFileFields(type186.fields, answers).map((f) => f.key);
    expect(keys({ bank_account_is_own: false })).toEqual(["authorization_letter"]);
    expect(keys({ bank_account_is_own: true })).toEqual([]);
    expect(keys({})).toEqual(["authorization_letter"]);
    expect(expectedFileFields(typeOld.fields, { bank_account_is_own: true }).map((f) => f.key)).toEqual(["authorization_letter"]);
  });
});

describe.each(LOCALES)("the staff notes about the payout account in %s", (locale) => {
  const t = tr(locale, "Compliance.bankOwn");

  it("shows the calm 'check before paying' note for a Yes whose names differ, and nothing else", () => {
    const html = page(locale, <BankFlags d={detail({ data: { bank_account_is_own: true, name_differs: true } })} />);
    expect(text(html)).toContain(t("nameDiffers"));
    expect(html).toContain('data-flag="name_differs"');
    expect(html).toContain('role="note"');
    expect(html).not.toContain('role="alert"');
    expect(text(html)).not.toContain(t("thirdParty"));
    // the flag holds no name: only the words
    expect(html).not.toContain("Siti");
  });

  it("shows the third-party note with a link to the letter for a No", () => {
    const html = page(locale, <BankFlags d={detail({ data: { bank_account_is_own: false }, files: [letter] })} />);
    expect(text(html)).toContain(t("thirdParty"));
    expect(html).toContain('data-flag="third_party"');
    expect(html).toContain("/api/compliance/requests/r1/files/f1");
    expect(text(html)).toContain("letter-from-owner.pdf");
    expect(text(html)).not.toContain(t("nameDiffers"));
  });

  it("shows the file name but no link to a viewer who may not open files, and says when the letter is missing", () => {
    const noOpen = page(locale, <BankFlags d={detail({ data: { bank_account_is_own: false }, files: [letter], viewer: viewer({ canReview: false }) })} />);
    expect(text(noOpen)).toContain("letter-from-owner.pdf");
    expect(noOpen).not.toContain("/api/compliance/requests/r1/files/f1");
    const missing = page(locale, <BankFlags d={detail({ data: { bank_account_is_own: false }, files: [] })} />);
    expect(text(missing)).toContain(t("thirdPartyMissing"));
    expect(missing).toContain('data-flag="third_party_missing"');
  });

  it("shows nothing for an own account with matching names, or for a case from before the question", () => {
    expect(page(locale, <BankFlags d={detail({ data: { bank_account_is_own: true, name_differs: false } })} />)).toBe("");
    expect(page(locale, <BankFlags d={detail({ data: { reason: "x" } })} />)).toBe("");
  });

  it("says 'Not asked (older form)' in the answers of a case made before the question, and Yes / No after it", () => {
    const old = page(locale, <AnswersPanel {...props(detail({ data: { reason: "Moving abroad" } }))} />);
    expect(text(old)).toContain(tr(locale, "Compliance.answers")("notAsked"));
    const yes = page(locale, <AnswersPanel {...props(detail({ data: { reason: "Moving abroad", bank_account_is_own: true } }))} />);
    expect(text(yes)).not.toContain(tr(locale, "Compliance.answers")("notAsked"));
    expect(text(yes)).toContain(tr(locale, "Compliance")("yes"));
    const no = page(locale, <AnswersPanel {...props(detail({ data: { reason: "Moving abroad", bank_account_is_own: false } }))} />);
    expect(text(no)).toContain(tr(locale, "Compliance")("no"));
    // the flag itself is not an answer row
    expect(text(page(locale, <AnswersPanel {...props(detail({ data: { bank_account_is_own: true, name_differs: true } }))} />))).not.toContain("name_differs");
  });

  it("lists the authorization letter in the Files panel only while the account is somebody else's", () => {
    const label = "Authorization letter";
    const own = page(locale, <FilesPanel {...props(detail({ data: { bank_account_is_own: true } }))} />);
    const third = page(locale, <FilesPanel {...props(detail({ data: { bank_account_is_own: false } }))} />);
    expect(text(third)).toContain(label);
    expect(text(own)).not.toContain(label);
  });

  it("renders without a React warning", () => {
    page(locale, <BankFlags d={detail({ data: { bank_account_is_own: true, name_differs: true } })} />);
    page(locale, <BankFlags d={detail({ data: { bank_account_is_own: false }, files: [letter] })} />);
    expect(errors).toEqual([]);
  });
});

describe("the wording", () => {
  it("has the staff notes in all four languages, without a name in them, and the English words the owner asked for", () => {
    for (const l of LOCALES) {
      const bank = (CATALOGUES[l].Compliance as Tree).bankOwn as Record<string, string>;
      expect(Object.keys(bank).sort(), l).toEqual(["nameDiffers", "thirdParty", "thirdPartyMissing"]);
      for (const v of Object.values(bank)) expect(v.trim().length, l).toBeGreaterThan(5);
      expect((((CATALOGUES[l].Compliance as Tree).answers as Tree).notAsked as string).length, l).toBeGreaterThan(3);
    }
    const en = tr("en", "Compliance.bankOwn");
    expect(en("nameDiffers")).toBe("Bank holder name differs from the account holder name: check before paying.");
    expect(en("thirdParty")).toBe("Payout to a third party: authorization letter on file");
    expect(tr("en", "Compliance.answers")("notAsked")).toBe("Not asked (older form)");
  });
});
