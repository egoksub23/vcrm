import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// Render smoke tests for bulk send in every language, with the real wording: next-intl is told to throw on a
// missing key or argument instead of printing a raw key path. Effects do not run under renderToStaticMarkup, so
// what is checked is the first paint. The wording is read from messages/<locale>.json (Sign.bulk); until the
// orchestrator has merged the fragment, SIGN_I18N_FRAGMENTS may point at the folder holding bulk-wp17.json.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ accountId: "a1" }), useCapability: () => true }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {} }), usePathname: () => "/sign" }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));

import type { BulkJobView, BulkPreview, BulkRowView } from "@/lib/sign/bulk/types";
import { BULK_ERROR_CODES, EMPTY_FORM, bulkErrorKey, fileProblemKey, planProblemKey, rowReasonKey, type WizardForm } from "@/lib/sign/client/bulk";
import { FILE_PROBLEM_CODES, PLAN_PROBLEM_CODES, ROW_PROBLEM_CODES } from "@/lib/sign/bulk/types";

const jobState: { job: BulkJobView | null; rows: BulkRowView[]; errorCode: string | null; loading: boolean } = { job: null, rows: [], errorCode: null, loading: false };
vi.mock("@/hooks/use-sign-bulk", () => ({
  useBulkJob: () => ({ ...jobState, refresh: () => {} }),
  useRecentBatches: () => ({ jobs: recent, loading: false, error: false, refresh: () => {} }),
  useTemplateFacts: () => ({ facts: null, loading: false, error: false }),
}));
const recent: BulkJobView[] = [];

import { SelectionBar } from "@/components/sign/list/selection-bar";
import { ListActions } from "@/components/sign/list/list-actions";
import { DocumentCards, DocumentTable } from "@/components/sign/list/document-rows";
import { BulkJobScreen } from "./bulk-job";
import { BulkWizard } from "./bulk-wizard";
import { PeopleStep } from "./people-step";
import { ProblemList, useProblemWords } from "./problem-text";
import { RecentBatches } from "./recent-batches";
import { ReviewStep } from "./review-step";
import { SetupStep } from "./setup-step";

function tree(locale: string, key: "bulk" | "send"): Record<string, unknown> | null {
  const merged = join(process.cwd(), "messages", `${locale}.json`);
  if (existsSync(merged)) {
    const found = (JSON.parse(readFileSync(merged, "utf8")) as { Sign?: Record<string, Record<string, unknown>> }).Sign?.[key];
    if (found) return found;
  }
  const dir = process.env.SIGN_I18N_FRAGMENTS;
  if (key === "bulk" && dir && existsSync(join(dir, "bulk-wp17.json"))) return (JSON.parse(readFileSync(join(dir, "bulk-wp17.json"), "utf8")) as Record<string, Record<string, unknown>>)[locale] ?? null;
  return null;
}
const LOCALES = ["en", "ms", "zh", "ko"].filter((l) => tree(l, "bulk") !== null);

function page(locale: string, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      // the list's own words (Sign.send) are not this package's: the English ones stand in
      messages={{ Sign: { bulk: tree(locale, "bulk"), send: tree("en", "send") } }}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const role = (key: string, label: string, needsPerson = true) => ({ key, label, kind: "signer" as const, needsPerson });
const roles = [role("merchant", "Merchant"), role("director", "Director")];

const form = (over: Partial<WizardForm> = {}): WizardForm => ({ ...EMPTY_FORM, templateId: "t1", personRole: "merchant", ...over });

const preview = (over: Partial<BulkPreview> = {}): BulkPreview => ({
  template: { id: "t1", name: "Merchant Agreement", mergeKeys: ["business_name", "fee"], roles },
  file: { problems: [], ignoredColumns: [], rowCount: 3 },
  plan: { problems: [] },
  rows: [
    { rowNo: 1, name: "Ali bin Ahmad", email: "ali@kedai.example", phone: null, contactId: null, merge: { business_name: "Kedai Ali" }, problems: [] },
    { rowNo: 2, name: "", email: "bad", phone: null, contactId: null, merge: {}, problems: ROW_PROBLEM_CODES.map((code) => ({ code, detail: code === "email_duplicate" ? "1" : "fee" })) },
  ],
  counts: { total: 2, ok: 1, withProblems: 1 },
  headroom: { limit: 100, used: 10, remaining: 90, needed: 1, fits: true },
  ...over,
});

const job = (over: Partial<BulkJobView> = {}): BulkJobView => ({
  id: "j1",
  templateId: "t1",
  templateName: "Merchant Agreement",
  status: "running",
  source: "csv",
  fileName: "merchants.csv",
  total: 6,
  sent: 2,
  failed: 1,
  skipped: 1,
  pending: 2,
  errorCode: null,
  createdAt: "2026-10-06T08:00:00Z",
  startedAt: "2026-10-06T08:01:00Z",
  finishedAt: null,
  ...over,
});
const row = (n: number, over: Partial<BulkRowView> = {}): BulkRowView => ({ rowNo: n, name: `Person ${n}`, email: `p${n}@example.com`, state: "sent", documentId: `d${n}`, reference: `SGN-2026-00000${n}`, errorCode: null, errorMessage: null, inFlight: false, ...over });

describe("the words of every code the screens can meet", () => {
  it("name a key for every code the server answers with", () => {
    for (const code of BULK_ERROR_CODES) expect(bulkErrorKey(code)).toBe(`errors.${code}`);
    expect(bulkErrorKey("something_new")).toBe("errors.generic");
    expect(bulkErrorKey(null)).toBe("errors.generic");
    expect(rowReasonKey("sign_limit_reached")).toBe("reason.sign_limit_reached");
    expect(rowReasonKey("never_heard_of_it")).toBe("reason.unknown");
    expect(fileProblemKey("nope")).toBe("file.unknown");
    expect(planProblemKey("nope")).toBe("plan.template_not_ready");
  });
});

describe.skipIf(LOCALES.length === 0)("bulk send renders in every language", () => {
  for (const locale of LOCALES) {
    it(`has a sentence for every problem, failure and plan code (${locale})`, () => {
      const t = tree(locale, "bulk") as Record<string, Record<string, string>>;
      for (const c of ROW_PROBLEM_CODES) expect(t.problem[c], `problem.${c}`).toBeTypeOf("string");
      for (const c of FILE_PROBLEM_CODES) expect(t.file[c], `file.${c}`).toBeTypeOf("string");
      for (const c of PLAN_PROBLEM_CODES) expect(t.plan[c], `plan.${c}`).toBeTypeOf("string");
      for (const c of BULK_ERROR_CODES) expect(t.errors[c], `errors.${c}`).toBeTypeOf("string");
      expect(t.errors.generic).toBeTypeOf("string");
      for (const c of ["sign_limit_reached", "cancelled", "gave_up", "sign_disabled", "template_not_found", "template_not_active", "not_ready", "unexpected"]) expect(t.reason[c], `reason.${c}`).toBeTypeOf("string");
    });

    it(`people, setup and review steps (${locale})`, () => {
      expect(page(locale, <PeopleStep form={form()} mergeKeys={["business_name", "fee"]} onChange={() => {}} />)).toContain("business_name, fee");
      expect(page(locale, <PeopleStep form={form({ csvText: "full_name,email\n", fileName: "merchants.csv" })} mergeKeys={[]} onChange={() => {}} />)).toContain("merchants.csv");
      const contacts = page(locale, <PeopleStep form={form({ source: "contacts", contacts: [{ id: "c1", name: "Ali", email: "ali@example.com" }, { id: "c2", name: null, email: null }] })} mergeKeys={["fee"]} onChange={() => {}} />);
      expect(contacts).toContain("ali@example.com");
      expect(contacts).toContain('role="alert"');

      const setup = (f: WizardForm, problems: string[], show: boolean) => page(locale, <SetupStep form={f} roles={roles} categories={[]} problems={problems} showInvalid={show} onChange={() => {}} />);
      expect(setup(form(), [], false)).toContain("Director");
      const invalid = setup(form({ personRole: null, expiryDays: "x", reminderText: "99", message: "m".repeat(2001), title: "t".repeat(201), fixed: { director: { fullName: "G", email: "nope", phone: "", channel: "whatsapp" } } }), ["personRole", "expiryDays", "reminders", "message", "title", "fixed:director"], true);
      expect(invalid).toContain('role="alert"');
      expect(setup(form({ channel: "whatsapp" }), [], false)).toBeTruthy();

      const review = (p: BulkPreview | null, over: { loading?: boolean; errorKey?: string | null; skip?: boolean } = {}) =>
        page(locale, <ReviewStep preview={p} loading={over.loading ?? false} errorKey={over.errorKey ?? null} skipInvalid={over.skip ?? false} onSkipInvalid={() => {}} onRecheck={() => {}} />);
      const full = review(preview());
      expect(full).toContain("Ali bin Ahmad");
      expect(full).toContain("<table");
      expect(review(preview({ file: { problems: FILE_PROBLEM_CODES.map((code) => ({ code, detail: "email" })), ignoredColumns: ["company"], rowCount: 0 }, plan: { problems: PLAN_PROBLEM_CODES.map((code) => ({ code, detail: "director" })) } }))).toContain('role="alert"');
      expect(review(preview({ headroom: { limit: 100, used: 99, remaining: 1, needed: 2, fits: false } }))).toContain('role="alert"');
      expect(review(preview({ headroom: { limit: null, used: 0, remaining: null, needed: 1, fits: true } }), { skip: true })).toBeTruthy();
      expect(review(null, { loading: true })).toContain('role="status"');
      expect(review(null, { errorKey: "errors.rate_limited" })).toContain('role="alert"');
      expect(review(null, { errorKey: null })).toContain('role="alert"');
    });

    it(`the batch screen in every state, and the recent batches (${locale})`, () => {
      const rows = [
        row(1),
        row(2, { state: "failed", errorCode: "sign_limit_reached", errorMessage: "limit" }),
        row(3, { state: "failed", errorCode: "contact_not_found", documentId: null, reference: null }),
        row(4, { state: "skipped", errorCode: "merge_missing:fee", documentId: null, reference: null }),
        row(5, { state: "skipped", errorCode: "cancelled", documentId: null, reference: null }),
        row(6, { state: "failed", errorCode: "some_new_code", errorMessage: "A sentence from the server.", documentId: null, reference: null }),
        row(7, { state: "failed", errorCode: "some_new_code", errorMessage: null, documentId: null, reference: null }),
        row(8, { state: "pending", documentId: null, reference: null, inFlight: true }),
        row(9, { state: "pending", documentId: null, reference: null }),
      ];
      for (const status of ["queued", "running", "done", "failed", "cancelled"] as const) {
        Object.assign(jobState, { job: job({ status, errorCode: status === "failed" ? "sign_disabled" : null, finishedAt: status === "running" || status === "queued" ? null : "2026-10-06T09:00:00Z" }), rows, errorCode: null, loading: false });
        const html = page(locale, <BulkJobScreen id="j1" />);
        expect(html).toContain('role="progressbar"');
        expect(html).toContain("/sign/d1");
      }
      Object.assign(jobState, { job: job({ status: "done", failed: 0, skipped: 0, sent: 6, pending: 0, finishedAt: "2026-10-06T09:00:00Z" }), rows: [row(1)], errorCode: null });
      expect(page(locale, <BulkJobScreen id="j1" />)).toContain("SGN-2026-000001");
      Object.assign(jobState, { job: job(), rows: [], errorCode: "network" });
      expect(page(locale, <BulkJobScreen id="j1" />)).toContain('role="alert"');
      Object.assign(jobState, { job: null, rows: [], errorCode: "job_not_found", loading: false });
      expect(page(locale, <BulkJobScreen id="j1" />)).toContain('role="alert"');
      Object.assign(jobState, { job: null, rows: [], errorCode: null, loading: true });
      expect(page(locale, <BulkJobScreen id="j1" />)).toContain('role="status"');

      recent.splice(0, recent.length, job({ id: "r1" }), job({ id: "r2", status: "done" }));
      expect(page(locale, <RecentBatches />)).toContain("/sign/bulk/r1");
      recent.splice(0, recent.length);
    });

    it(`the list's export, bulk send and zip actions, and the tick boxes (${locale})`, () => {
      expect(page(locale, <ListActions filters={{ group: "all", category: "all", search: "" }} canSend />)).toContain("/sign/bulk");
      expect(page(locale, <ListActions filters={{ group: "all", category: "all", search: "" }} canSend={false} />)).not.toContain("/sign/bulk");
      expect(page(locale, <SelectionBar ids={["a", "b"]} max={50} onClear={() => {}} />)).toContain('role="region"');
      expect(page(locale, <SelectionBar ids={Array.from({ length: 50 }, (_, i) => `d${i}`)} max={50} onClear={() => {}} />)).toContain('role="region"');

      const docs = [
        { id: "d1", reference: "SGN-2026-000001", title: "Merchant Agreement", status: "completed", category_id: null, contact_id: null, sign_in_order: false, sent_at: "2026-10-06T08:00:00Z", expires_at: null, completed_at: "2026-10-07T08:00:00Z", created_at: "2026-10-06T08:00:00Z", updated_at: "2026-10-07T08:00:00Z", contacts: null, sign_signers: [] },
        { id: "d2", reference: null, title: "NDA", status: "draft", category_id: null, contact_id: null, sign_in_order: false, sent_at: null, expires_at: null, completed_at: null, created_at: "2026-10-06T08:00:00Z", updated_at: "2026-10-06T08:00:00Z", contacts: null, sign_signers: [] },
      ] as never[];
      const selection = { selected: new Set(["d1"]), ids: ["d1"], max: 50, toggle: () => {}, toggleAll: () => {} };
      const table = page(locale, <DocumentTable rows={docs} categories={[]} now={Date.parse("2026-10-08T00:00:00Z")} selection={selection} />);
      expect(table).toContain('type="checkbox"');
      expect(table).not.toContain("undefined");
      expect(page(locale, <DocumentCards rows={docs} categories={[]} now={Date.parse("2026-10-08T00:00:00Z")} selection={selection} />)).toContain("Merchant Agreement");
      // without a selection the list is as it was
      expect(page(locale, <DocumentTable rows={docs} categories={[]} now={0} />)).not.toContain('type="checkbox"');
    });

    it(`the wizard's first screen, with a template from the address and without (${locale})`, () => {
      const first = page(locale, <BulkWizard />);
      expect(first).toContain('aria-current="step"');
      expect(first).toContain("<nav");
      // a template named in the address starts at the people step
      const people = page(locale, <BulkWizard templateId="11111111-1111-4111-8111-111111111111" />);
      expect(people).toContain("bulk-source");
    });

    it(`words a problem list (${locale})`, () => {
      function Probe() {
        const w = useProblemWords();
        return (
          <div>
            <ProblemList problems={[{ code: "merge_missing", detail: "fee" }]} word={w.row} />
            <p>{w.reason("merge_missing:fee", null)}</p>
            <p>{w.reason("email_duplicate:3", null)}</p>
            <p>{w.reason("contact_not_found", null)}</p>
            <p>{w.reason("unknown_code", "From the server")}</p>
            <p>{w.reason(null, null)}</p>
          </div>
        );
      }
      expect(page(locale, <Probe />)).toContain("fee");
    });
  }
});
