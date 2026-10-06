import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// Render checks for what work package 20b put on screen, in the four languages, with the real wording and next-intl told to throw on a
// missing key or argument (so a raw key can never show): the add-on update panel, the test-mode dialog, the replace-file dialog, the
// ticket and deal pickers, the Documents panel on a ticket or deal, the Test marks (list, detail, signing page). They run once the
// fragments (`<area>-wp20b.json`) are merged into messages/*.json. Before that, point SIGN_I18N_OVERLAY at the folder that holds the
// fragments and the same checks run against them merged in memory.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "acct", user: { id: "u1", email: "gokula@vircle.example" } }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));

import { Dialog } from "@/components/ui/dialog";
import type { SignListRow } from "@/hooks/use-sign-documents";
import type { AddonCard } from "@/lib/sign/addons/install";
import type { UpdateResult } from "@/lib/sign/addons/update";
import type { ReplaceAnswer } from "@/lib/sign/client/replace-file";
import type { SignerLocale } from "@/lib/sign/client/signer-flow";
import type { DraftOptions } from "@/lib/sign/client/draft-options";
import type { PlacedField } from "@/lib/sign/pdf/types";
import type { SignDocumentRow, SignRole } from "@/lib/sign/types";
import { UpdatePanel, UpdateResultNote, changeLines } from "@/components/settings/sign/addon-update";
import { DetailHeader } from "./detail/detail-header";
import { DocumentRows, RecordDocuments, ContactDocuments } from "./detail/contact-documents";
import { documentActions } from "./detail/logic";
import { PlanSummary, ReplaceFileBody } from "./editor/replace-file-dialog";
import { TestSendBody } from "./editor/test-send-dialog";
import { MetaLine, TestBadge } from "./list/row-parts";
import { OptionsStep } from "./send/options-step";
import { RecordPicker } from "./send/record-picker";
import { Shell } from "./signer/shell";

const LOCALES: SignerLocale[] = ["en", "ms", "zh", "ko"];
type Json = Record<string, unknown>;

function merge(into: Json, from: Json): Json {
  for (const [k, v] of Object.entries(from)) {
    if (typeof v === "object" && v !== null) into[k] = merge((into[k] as Json) ?? {}, v as Json);
    else into[k] = v;
  }
  return into;
}

function messagesFor(locale: string): Json {
  const all = JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as Json;
  const dir = process.env.SIGN_I18N_OVERLAY;
  if (dir && existsSync(dir)) {
    const sign = (all.Sign ??= {}) as Json;
    // every package's fragments, as the merged files will have them (the options step needs the forwarding words of another package)
    for (const file of readdirSync(dir).filter((f) => /^[A-Za-z]+-wp\d+[a-z]?\.json$/.test(f)).sort()) {
      const area = file.split("-")[0];
      const fragment = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<string, Json>;
      sign[area] = merge((sign[area] as Json) ?? {}, fragment[locale] ?? {});
    }
  }
  return all;
}

const catalogue = Object.fromEntries(LOCALES.map((l) => [l, messagesFor(l)])) as Record<SignerLocale, Json>;
const sign = (l: SignerLocale) => catalogue[l].Sign as Record<string, Json>;
const merged = LOCALES.every((l) => ((sign(l).editor as Json | undefined)?.testSend as Json | undefined)?.title !== undefined && (sign(l).send as Json | undefined)?.records !== undefined && (sign(l).signer as Json | undefined)?.common !== undefined);

const html = (node: React.ReactNode, locale: SignerLocale) =>
  renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={catalogue[locale]}
      timeZone="UTC"
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
// the dialogs' frames are portals: what is inside them is drawn in the dialog's own root
const inDialog = (node: React.ReactNode) => (
  <Dialog open onOpenChange={() => {}}>
    {node}
  </Dialog>
);
const noop = () => {};

const roles: SignRole[] = [
  { key: "merchant", label: "Merchant", kind: "signer", color: 0 },
  { key: "director", label: "Director", kind: "signer", color: 1 },
];
const fields: PlacedField[] = [
  { key: "f_sig", type: "signature", role: "merchant", page: 0, x: 0.1, y: 0.5, w: 0.3, h: 0.06, required: true },
  { key: "f_txt", type: "text", role: "merchant", page: 1, x: 0.1, y: 0.2, w: 0.3, h: 0.04, required: false, label: "Company name" },
  { key: "f_dsig", type: "signature", role: "director", page: 2, x: 0.1, y: 0.5, w: 0.3, h: 0.06, required: true },
];

const card = (over: Partial<AddonCard> = {}): AddonCard => ({
  key: "merchant",
  version: "2.0",
  nameKey: "merchant.name",
  descriptionKey: "merchant.about",
  requires: "sign_merchant",
  available: true,
  installed: { version: "1.1", installedAt: "2026-09-01T00:00:00Z" },
  updateAvailable: true,
  changes: [{ version: "2.0", items: { en: ["English change one.", "English change two."], ms: ["Perubahan satu."], zh: ["变更一。"], ko: ["변경 하나."] } }],
  category: { key: "merchant_agreements", name: "Merchant agreements" },
  templates: { installable: 1, announced: 0 },
  ...over,
});

describe.skipIf(!merged)("what work package 20b put on screen, in four languages", () => {
  for (const locale of LOCALES) {
    describe(locale, () => {
      it("shows the add-on update: what changed in the reader's language, the button, and what the update did", () => {
        const panel = html(<UpdatePanel card={card()} busy={false} disabled={false} onUpdate={noop} />, locale);
        expect(panel).toContain("v2.0");
        // the add-on's own wording for this language is shown (English is only the fallback)
        const own = { en: "English change one.", ms: "Perubahan satu.", zh: "变更一。", ko: "변경 하나." }[locale];
        expect(panel).toContain(own);
        expect(html(<UpdatePanel card={card({ updateAvailable: false, changes: [] })} busy={false} disabled={false} onUpdate={noop} />, locale)).toBe("");
        const results: UpdateResult["templates"] = [
          { name: "Merchant Application", outcome: "updated", versionNo: 3 },
          { name: "Merchant Application", outcome: "copied", copyName: "Merchant Application (updated)" },
          { name: "Old", outcome: "missing" },
          { name: "Current", outcome: "current" },
        ];
        const note = html(<UpdateResultNote name="Merchant Registration" result={{ key: "merchant", fromVersion: "1.1", toVersion: "2.0", upToDate: false, templates: results }} onDismiss={noop} />, locale);
        expect(note).toContain("Merchant Application (updated)");
        expect(note).toContain("Merchant Registration");
        expect(note).toContain('role="status"');
      });

      it("shows the test dialog: what a test is, the address box, a place for each role, and the problems", () => {
        const props = { templateId: "t1", roles, fields, form: null, unsaved: false, onOpenChange: noop, ownAddress: "gokula@vircle.example" };
        const body = html(inDialog(<TestSendBody {...props} />), locale);
        expect(body).toContain("gokula@vircle.example");
        expect(body).toContain("test-role-merchant");
        expect(body).toContain("test-role-director");
        expect(html(inDialog(<TestSendBody {...props} unsaved />), locale)).toContain('role="status"');
        // a template with nobody to sign says so, and offers no address box
        const empty = html(inDialog(<TestSendBody {...props} fields={[]} />), locale);
        expect(empty).toContain('role="alert"');
        expect(empty).not.toContain('id="test-email"');
        // one place only: no list of places
        expect(html(inDialog(<TestSendBody {...props} fields={[fields[0]]} />), locale)).not.toContain("test-role-merchant");
      });

      it("shows the replace-file dialog and its plan: kept, moved, size changed, nothing to move", () => {
        expect(html(inDialog(<ReplaceFileBody documentId="d1" fields={fields} open onOpenChange={noop} beforeStart={async () => true} onReplaced={noop} />), locale)).toContain('type="file"');
        const plan = (over: Partial<ReplaceAnswer>): ReplaceAnswer => ({ dryRun: true, kept: 3, flagged: [], oldPageCount: 3, newPageCount: 3, pageCountChanged: false, converted: false, fields, ...over });
        expect(html(<PlanSummary plan={plan({})} fields={fields} />, locale)).toContain("3");
        const flagged = html(
          <PlanSummary
            plan={plan({
              kept: 1,
              oldPageCount: 3,
              newPageCount: 2,
              pageCountChanged: true,
              converted: true,
              flagged: [
                { key: "f_dsig", reason: "page_missing", page: 2, movedTo: 1 },
                { key: "f_txt", reason: "size_changed", page: 1 },
                { key: "f_gone", reason: "outside_page", page: 0 },
              ],
            })}
            fields={fields}
          />,
          locale,
        );
        // the label when there is one, the kind of field when there is not, and a plain word for a field that is no longer known
        expect(flagged).toContain("Company name");
        expect(flagged).toContain("<ul");
        expect(html(<PlanSummary plan={plan({ kept: 0 })} fields={[]} />, locale)).toContain("emerald");
      });

      it("shows the ticket and deal pickers on the options step, and the picker with a record already chosen", () => {
        const options: DraftOptions = { title: "Merchant Agreement", categoryId: null, contactId: null, locale: "en", message: "", expiryDate: "", reminderText: "3, 7", codeRequired: false, signInOrder: false, allowForwarding: false, ticketId: null, dealId: null };
        const step = html(<OptionsStep options={options} categories={[]} defaultExpiryDays={14} now={Date.UTC(2026, 9, 8)} showInvalid={false} readOnly={false} onChange={noop} />, locale);
        expect(step).toContain('id="opt-ticket"');
        expect(step).toContain('id="opt-deal"');
        expect(html(<OptionsStep options={{ ...options, contactId: "c1" }} categories={[]} defaultExpiryDays={14} now={Date.UTC(2026, 9, 8)} showInvalid={false} readOnly={false} onChange={noop} />, locale)).toContain('id="opt-ticket"');
        expect(html(<RecordPicker kind="ticket" value="t1" contactId={null} onChange={noop} />, locale)).toContain('role="status"');
        expect(html(<RecordPicker kind="deal" value={null} contactId="c1" onChange={noop} id="deal-box" />, locale)).toContain('id="deal-box"');
      });

      it("shows the Documents panel of a contact, a ticket and a deal, with the right send link and the Test mark", () => {
        expect(html(<ContactDocuments contactId="c1" />, locale)).toContain("/sign/new?contactId=c1");
        expect(html(<RecordDocuments kind="ticket" id="t1" contactId="c1" />, locale)).toContain("/sign/new?contactId=c1&amp;ticketId=t1");
        expect(html(<RecordDocuments kind="deal" id="d1" />, locale)).toContain("/sign/new?dealId=d1");
        const rows = [
          { id: "x1", reference: "SGN-2026-000001", title: "Merchant Agreement", status: "completed", test: false, created_at: "2026-10-01T00:00:00Z", sent_at: "2026-10-02T00:00:00Z", completed_at: "2026-10-03T00:00:00Z" },
          { id: "x2", reference: null, title: "Try-out", status: "sent", test: true, created_at: "2026-10-04T00:00:00Z", sent_at: null, completed_at: null },
        ];
        const list = html(<DocumentRows rows={rows} kind="ticket" />, locale);
        expect(list).toContain("/sign/x1");
        expect(list).toContain("uppercase");
        // the Test mark is on the test row only
        expect(list.split("uppercase").length - 1).toBe(1);
        for (const kind of ["contact", "ticket", "deal"] as const) expect(html(<DocumentRows rows={[]} kind={kind} />, locale)).toContain("<p");
      });

      it("marks a test document in the list, on the detail header and on the signing page", () => {
        const row = { id: "r1", reference: "SGN-1", title: "T", status: "sent", mode: "sign", test: true, category_id: null, contact_id: null, sign_in_order: false, sent_at: null, expires_at: null, completed_at: null, created_at: "", updated_at: "", contacts: null, sign_signers: [] } as unknown as SignListRow;
        const withTest = html(<MetaLine row={row} categories={[]} />, locale);
        expect(withTest).toContain("uppercase");
        expect(html(<MetaLine row={{ ...row, test: false }} categories={[]} />, locale)).not.toContain("uppercase");
        expect(html(<TestBadge />, locale)).toContain("uppercase");

        const document = { id: "d1", reference: "SGN-2026-000123", title: "Merchant Agreement", status: "sent", mode: "sign", test: true, sign_in_order: false, code_required: false, created_at: "2026-10-06T09:04:00Z", sent_at: "2026-10-06T09:10:00Z", completed_at: null, expires_at: null, roles_snapshot: roles } as unknown as SignDocumentRow;
        const header = html(
          <DetailHeader document={document} links={{ category: null, contact: null, ticket: { id: "t1", number: 12, subject: "Printer" }, deal: { id: "d9", title: "Q4 renewal" } }} actions={documentActions({ status: "sent", base_path: "b", final_path: null, original_path: null, mode: "sign" }, { void: true })} downloading={null} onView={noop} onDownload={noop} onVoid={noop} />,
          locale,
        );
        expect(header).toContain("uppercase");
        expect(header).toContain("/tickets/t1");
        expect(header).toContain("Q4 renewal");
        expect(html(<DetailHeader document={{ ...document, test: false }} links={{ category: null, contact: null, ticket: null, deal: null }} actions={documentActions({ status: "sent", base_path: "b", final_path: null, original_path: null, mode: "sign" }, { void: true })} downloading={null} onView={noop} onDownload={noop} onVoid={noop} />, locale)).not.toContain("uppercase");

        const shell = (test: boolean) => html(<Shell workspace={{ name: "Vircle", logoUrl: null }} locale={locale} onLocaleChange={noop} product="Halo" test={test}>content</Shell>, locale);
        expect(shell(true)).toContain('role="note"');
        expect(shell(false)).not.toContain('role="note"');
      });
    });
  }

  it("has the same keys and placeholders in every language, and no empty text", () => {
    const dir = process.env.SIGN_I18N_OVERLAY;
    const flat = (x: unknown, prefix = ""): [string, string][] => (typeof x === "string" ? [[prefix, x]] : typeof x === "object" && x ? Object.entries(x).flatMap(([k, v]) => flat(v, prefix ? `${prefix}.${k}` : k)) : []);
    // the fragment files themselves, when they are at hand (the merged files are checked by the renders above)
    if (!dir || !existsSync(dir)) return;
    for (const file of readdirSync(dir).filter((f) => f.endsWith("-wp20b.json"))) {
      const fragment = JSON.parse(readFileSync(join(dir, file), "utf8")) as Record<SignerLocale, Json>;
      const en = Object.fromEntries(flat(fragment.en));
      const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\s*[,}]/g)].map((m) => m[1]).sort().join(",");
      for (const locale of LOCALES) {
        const other = Object.fromEntries(flat(fragment[locale]));
        expect(Object.keys(other).sort(), `${file} ${locale}`).toEqual(Object.keys(en).sort());
        for (const [k, v] of Object.entries(other)) {
          expect(v.trim(), `${file} ${locale} ${k}`).not.toBe("");
          expect(placeholders(v), `${file} ${locale} ${k}`).toBe(placeholders(en[k]));
          // ICU syntax a render may not reach: braces balance, and no apostrophe (ICU would read it as a quote)
          expect(v.split("{").length, `${file} ${locale} ${k}`).toBe(v.split("}").length);
          expect(v.includes("'"), `${file} ${locale} ${k}`).toBe(false);
        }
      }
    }
  });
});

describe("changeLines", () => {
  const changes: AddonCard["changes"] = [
    { version: "1.5", items: { en: ["a", "b"], ms: ["satu"] } },
    { version: "2.0", items: { en: ["c"] } },
  ];

  it("takes the reader's language and falls back to English where the add-on has no words in it", () => {
    expect(changeLines(changes, "ms")).toEqual([
      { version: "1.5", items: ["satu"] },
      { version: "2.0", items: ["c"] },
    ]);
    expect(changeLines(changes, "ko")).toEqual([
      { version: "1.5", items: ["a", "b"] },
      { version: "2.0", items: ["c"] },
    ]);
    expect(changeLines([], "en")).toEqual([]);
  });

  it("falls back to English for an empty list in the reader's language, never showing nothing", () => {
    expect(changeLines([{ version: "2.0", items: { en: ["x"], zh: [] } }], "zh")).toEqual([{ version: "2.0", items: ["x"] }]);
  });
});
