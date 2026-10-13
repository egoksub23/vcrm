import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Render tests for Compliance requests, Part B, in every language, with the real wording from messages/<locale>.json (next-intl is told to throw on a
// missing key): the raise dialog and the status chips, the customer-email panel, the sign-off's rejection fields and notify ticks, the reports, the public
// forms' settings and the sidebar badge. renderToStaticMarkup paints the FIRST render only, so what is checked is what each state looks like.
// NOT covered (no DOM renderer): clicking, typing and focus, the real fetches, the toasts after a move, the debounce of the date range, the file download.

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "u1", email: "officer@example.test" }, profile: { full_name: "Olivia Officer", email: "officer@example.test" }, capabilities: new Set(["menu.compliance"]), refreshCapabilities: () => undefined }),
  useCapability: () => true,
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

import { REJECTION_CATEGORIES, REQUEST_STATUSES, type RequestDetail, type RequestSummary, type Viewer } from "@/lib/compliance/types";
import type { ComplianceReport } from "@/lib/compliance/reports";
import type { PublicFormSettings } from "@/lib/compliance/public/settings-types";
import type { RaiseContext, RaisedItem } from "@/lib/compliance/raise-types";
import { typeFromRow } from "@/lib/compliance/service/rows";
import { TYPE_ROWS } from "@/lib/compliance/test-support";

import { NoticesPanel, SignoffPanel, TimelinePanel } from "./detail-panels";
import { NewRequest } from "./new-request";
import { PublicFormCard, formUrl, parseMaxAmount } from "./public-forms-settings";
import { RaiseForm, RaisedChips, RaisedList, targetOf } from "./raise";
import { ReportBody } from "./reports-screen";
import { PRESETS, days, dayString, percent, presetRange, rangeValid } from "./reports-helpers";
import { ComplianceWaitingBadge } from "./waiting-badge";

const LOCALES = ["en", "ms", "zh", "ko"] as const;
type Locale = (typeof LOCALES)[number];
type Tree = Record<string, unknown>;
const catalogue = (locale: string): Tree => JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as Tree;
const CATALOGUES = Object.fromEntries(LOCALES.map((l) => [l, catalogue(l)])) as Record<Locale, Tree>;
const tr = (locale: Locale, namespace: string) => createTranslator({ locale, messages: CATALOGUES[locale] as never, namespace: namespace as never }) as unknown as (key: string, values?: Record<string, unknown>) => string;

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

// ---- fixtures ---------------------------------------------------------------------------------------------------------------------

const closureType = typeFromRow(TYPE_ROWS[0]);
const viewer = (over: Partial<Viewer> = {}): Viewer => ({ userId: "u1", canReview: true, canApprove: true, canReveal: false, canExecute: false, canManage: true, ...over });

const summary = (over: Partial<RequestSummary> = {}): RequestSummary => ({
  id: "r1",
  reference: "CMP-2026-000014",
  typeKey: "closure",
  typeLabel: "Account closure",
  typeLabelL10n: { ms: "Penutupan akaun", zh: "关闭账户", ko: "계정 해지" },
  status: "awaiting_signoff",
  customerName: "Siti Aminah",
  customerEmail: "siti@example.test",
  customerPhone: "+60123456789",
  receivedAt: "2026-10-04T08:00:00Z",
  targetDays: 14,
  hardStopDays: 30,
  targetDueAt: "2026-10-18T08:00:00Z",
  hardStopAt: "2026-11-03T08:00:00Z",
  pausedAt: null,
  completedAt: null,
  closedAt: null,
  assignedTo: { id: "u2", name: "Harun Head" },
  source: "form",
  isTest: false,
  ...over,
});
const detail = (over: Partial<RequestDetail> = {}): RequestDetail => ({
  ...summary(),
  channel: "web_form",
  customerLocale: "ms",
  emailVerifiedAt: "2026-10-04T07:58:00Z",
  notices: [],
  type: closureType,
  data: {},
  sensitive: [],
  sensitiveReadable: true,
  identityCheck: { outcome: "pass", verifiedBy: "u9", recordedBy: "u9" },
  review: { recommendation: "approve" },
  signoff: {},
  standing: { duesOutstanding: false },
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
});
const props = (d: RequestDetail) => ({ d, act: noop, busy: false, now: Date.parse("2026-10-12T12:00:00Z") });

const context: RaiseContext = {
  contact: { id: "c1", name: "Siti Aminah", phone: "012-334 4556", email: "siti@example.test", language: "ms" },
  channel: "whatsapp",
  chatLink: { available: true },
  types: [
    { key: "closure", label: "Account closure", labelL10n: { ms: "Penutupan akaun", zh: "关闭账户", ko: "계정 해지" }, fields: closureType.fields.filter((f) => f.type !== "file") },
    { key: "phone_change", label: "Phone number change", labelL10n: {}, fields: typeFromRow(TYPE_ROWS[2]).fields },
  ],
  open: [],
};
const items: RaisedItem[] = [
  { reference: "CMP-2026-000014", typeKey: "closure", typeLabel: "Account closure", typeLabelL10n: { ms: "Penutupan akaun" }, status: "in_review", raisedAt: "2026-10-12T08:00:00Z" },
  { reference: "CMP-2026-000009", typeKey: "phone_change", typeLabel: "Phone number change", typeLabelL10n: {}, status: "done", raisedAt: "2026-10-01T08:00:00Z", id: "case-9" },
];

const report: ComplianceReport = {
  filters: { from: "2026-07-15T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z", type: null },
  generatedAt: "2026-10-13T00:00:00.000Z",
  truncated: false,
  total: 12,
  open: 5,
  finished: 7,
  byType: [
    { key: "closure", total: 9, byStatus: { received: 1, identity_check: 0, officer_review: 1, awaiting_signoff: 1, approved: 0, rejected: 1, executing: 1, completed: 3, closed: 1 } },
    { key: "withdrawal", total: 3, byStatus: { received: 0, identity_check: 0, officer_review: 0, awaiting_signoff: 0, approved: 0, rejected: 0, executing: 0, completed: 2, closed: 1 } },
  ],
  clock: { considered: 8, withinTarget: 5, afterTarget: 2, afterStop: 0, openPastStop: 1 },
  timing: { toDecision: { count: 8, average: 4.5, median: 4 }, toCompletion: { count: 5, average: 9.2, median: 8.5 } },
  signoffs: [{ by: "u2", approved: 6, rejected: 2 }],
  rejections: [
    { category: "identity_failed", count: 1 },
    { category: "uncategorised", count: 1 },
  ],
  ageing: [
    { bucket: "d0_7", count: 2 },
    { bucket: "d8_14", count: 1 },
    { bucket: "d15_30", count: 1 },
    { bucket: "d31_plus", count: 1 },
  ],
  types: [
    { key: "closure", label: "Account closure", labelL10n: { ms: "Penutupan akaun", zh: "关闭账户", ko: "계정 해지" } },
    { key: "withdrawal", label: "Fund withdrawal", labelL10n: {} },
  ],
  people: [{ id: "u2", name: "Harun Head" }],
};

const form = (over: Partial<PublicFormSettings> = {}): PublicFormSettings => ({
  typeKey: "closure",
  exists: true,
  enabled: true,
  slug: "close-account-abc23456",
  notice: { en: "Read this first" },
  turnstile: false,
  maxAmount: 10000,
  banks: null,
  ready: true,
  ...over,
});

describe.each(LOCALES)("Compliance requests, Part B, in %s", (locale) => {
  const t = (ns: string) => tr(locale, `Compliance.${ns}`);

  it("shows the raise dialog: the types, the customer prefilled from the contact, the staff fields, the date, the note, the notify tick, and no file field", () => {
    const html = page(locale, <RaiseForm target={{ conversationId: "cv1" }} context={context} canOpen onRaised={() => undefined} onCancel={() => undefined} initial={{ typeKey: "closure", sendClosureForm: false }} />);
    const s = text(html);
    const r = t("raise");
    for (const k of ["type", "customer", "name", "phone", "email", "channel", "details", "tickHelp", "when", "whenNow", "whenEarlier", "note", "notify", "submit", "cancel"]) expect(s, k).toContain(r(k));
    expect(html).toContain('value="Siti Aminah"');
    expect(html).toContain('value="012-334 4556"');
    expect(html).toContain('value="siti@example.test"');
    expect(html).toContain('value="whatsapp"');
    expect(html).not.toContain('type="file"');
    expect(html).toContain(">" + (locale === "en" ? "Account closure" : locale === "ms" ? "Penutupan akaun" : locale === "zh" ? "关闭账户" : "계정 해지") + "<");
    expect(errors).toEqual([]);
  });

  it("asks for the date and a reason when 'Earlier' is chosen, and says why", () => {
    const s = text(page(locale, <RaiseForm target={{ ticketId: "tk1" }} context={context} canOpen onRaised={() => undefined} onCancel={() => undefined} initial={{ whenEarlier: true }} />));
    const r = t("raise");
    expect(s).toContain(r("whenAt"));
    expect(s).toContain(r("whenReason"));
    expect(s).toContain(r("whenReasonHelp"));
  });

  it("states that a customer with an open request of the type cannot be raised for again, without naming it", () => {
    const html = page(locale, <RaiseForm target={{ conversationId: "cv1" }} context={{ ...context, open: ["closure"] }} canOpen={false} onRaised={() => undefined} onCancel={() => undefined} initial={{ typeKey: "closure" }} />);
    expect(text(html)).toContain(t("raise")("openExists"));
    expect(html).not.toMatch(/CMP-\d/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*(<[^>]+>)*[^<]*<\/button>|disabled=""/);
  });

  it("shows the raiser's status chips and 'My raised requests': the reference, the type, the status, and a link only for a person who may open the case", () => {
    const chips = page(locale, <RaisedChips items={items} canOpen />);
    const r = t("raise");
    expect(text(chips)).toContain("CMP-2026-000014");
    expect(text(chips)).toContain(r("status.in_review"));
    expect(chips).toContain('data-status="in_review"');
    expect(chips).toContain('href="/compliance/case-9"');
    const noLink = page(locale, <RaisedChips items={items} canOpen={false} />);
    expect(noLink).not.toContain("href=");
    const list = page(locale, <RaisedList items={items} canOpen={false} />);
    expect(text(list)).toContain(r("mine.title"));
    expect(text(list)).toContain(r("status.done"));
    expect(list).not.toContain("href=");
    expect(text(page(locale, <RaisedList items={[]} canOpen={false} />))).toContain(r("mine.empty"));
    expect(page(locale, <RaisedChips items={[]} canOpen />)).toBe("");
    // nothing about the customer in either
    for (const html of [chips, list]) expect(html).not.toMatch(/Siti|siti@|\+60|8800/);
  });

  it("shows the sign-off's rejection fields, the preview button and both notify ticks (reject on, approve off)", () => {
    const html = page(locale, <SignoffPanel {...props(detail())} />);
    const s = text(html);
    const so = t("signoff");
    const n = t("notices");
    for (const k of ["internalHint", "rejectionTitle", "categoryLabel", "categoryChoose", "customerReasonLabel", "customerReasonHint"]) expect(s, k).toContain(so(k));
    for (const c of REJECTION_CATEGORIES) expect(s, c).toContain(so(`categories.${c}`));
    for (const k of ["preview", "notifyReject", "notifyApprove"]) expect(s, k).toContain(n(k));
    // reject is on by default, approve is off
    const boxes = [...html.matchAll(/<input type="checkbox"[^>]*>/g)].map((m) => m[0]);
    expect(boxes).toHaveLength(2);
    expect(boxes[0]).toContain('checked=""');
    expect(boxes[1]).not.toContain('checked=""');
  });

  it("explains in words that nothing can be emailed when the case has no address", () => {
    const s = text(page(locale, <SignoffPanel {...props(detail({ customerEmail: null }))} />));
    expect(s).toContain(t("notices")("noAddress"));
  });

  it("shows what was decided on a rejected case: the category and the words the customer was told", () => {
    const d = detail({ status: "rejected", signoff: { decision: "rejected", by: "u2", at: "2026-10-10T08:00:00Z", reason: "Mismatch", reasonCategory: "identity_failed", customerReason: "We could not match your details." } });
    const s = text(page(locale, <SignoffPanel {...props(d)} />));
    expect(s).toContain(t("signoff")("categories.identity_failed"));
    expect(s).toContain("We could not match your details.");
    expect(s).toContain(t("signoff")("customerReasonShown"));
  });

  it("lists the customer's emails with their result and a reason in words, and offers 'Send again' only for one that failed", () => {
    const d = detail({
      notices: [
        { kind: "received", audience: "customer", status: "sent", detail: null, language: "ms", claimedAt: "2026-10-04T08:00:01Z", by: null },
        { kind: "completed", audience: "customer", status: "failed", detail: "mailbox_reconnect", language: "ms", claimedAt: "2026-10-10T08:00:01Z", by: { id: "u2", name: "Harun Head" } },
        { kind: "signoff_waiting", audience: "staff", status: "sent", detail: null, language: null, claimedAt: "2026-10-09T08:00:01Z", by: null },
      ],
    });
    const html = page(locale, <NoticesPanel {...props(d)} />);
    const s = text(html);
    const n = t("notices");
    expect(s).toContain(n("kinds.received"));
    expect(s).toContain(n("status.sent"));
    expect(s).toContain(n("status.failed"));
    expect(s).toContain(n("reasons.mailbox_reconnect"));
    expect(s).toContain(n("sendAgain"));
    expect(s).not.toContain(n("kinds.signoff_waiting"));
    expect(html.match(/data-notice-status="failed"/g)).toHaveLength(1);
    expect((html.match(new RegExp(n("sendAgain"), "g")) ?? []).length).toBe(1);
    expect(s).toContain(n("askMore"));
    expect(html).not.toMatch(/siti@|example\.test/);
    expect(text(page(locale, <NoticesPanel {...props(detail({ notices: [] }))} />))).toContain(n("none"));
  });

  it("writes the emails into the timeline: sent, not sent with the reason, skipped", () => {
    const at = "2026-10-10T08:00:00Z";
    const d = detail({
      events: [
        { id: "e1", kind: "notice", at, actor: { id: "u2", name: "Harun Head" }, detail: { notice: "rejected", audience: "customer", status: "sent" } },
        { id: "e2", kind: "notice", at, actor: null, detail: { notice: "completed", audience: "customer", status: "failed", reason: "mailbox_reconnect" } },
        { id: "e3", kind: "notice", at, actor: null, detail: { notice: "received", audience: "customer", status: "skipped", reason: "no_address" } },
        { id: "e4", kind: "notice", at, actor: { id: "u3", name: "Olivia Officer" }, detail: { notice: "more_info", audience: "customer", status: "sent", text: "Please send the letter again." } },
      ],
    });
    const s = text(page(locale, <TimelinePanel {...props(d)} />));
    const n = t("notices");
    expect(s).toContain(n("kinds.rejected"));
    expect(s).toContain(n("reasons.mailbox_reconnect"));
    expect(s).toContain(n("reasons.no_address"));
    expect(s).toContain("Please send the letter again.");
  });

  it("shows the New request form's notify tick on by default once there is an address", () => {
    const html = page(locale, <NewRequest types={[closureType]} onCancel={() => undefined} onCreated={() => undefined} />);
    expect(text(html)).toContain(t("notices")("noAddress"));
  });

  it("shows the reports: every table with its numbers, in words and never colour alone", () => {
    const html = page(locale, <ReportBody report={report} />);
    const s = text(html);
    const r = t("reports");
    for (const k of ["total", "open", "finished", "byType.title", "clock.title", "clock.withinTarget", "clock.afterTarget", "clock.afterStop", "clock.openPastStop", "timing.title", "timing.toDecision", "timing.toCompletion", "signoffs.title", "rejections.title", "rejections.categories.identity_failed", "rejections.categories.uncategorised", "ageing.title", "ageing.buckets.d31_plus", "retention"]) expect(s, k).toContain(r(k));
    for (const st of REQUEST_STATUSES) expect(s, st).toContain(t("status")(st));
    expect(s).toContain("Harun Head");
    expect(html.match(/<table/g)).toHaveLength(6);
    expect(html.match(/<caption/g)).toHaveLength(6);
    expect(html).toContain('scope="col"');
    expect(html).toContain('scope="row"');
    // a share is a number as well as a bar
    expect(s).toContain("63%");
    // the type names follow the language
    expect(s).toContain(locale === "ms" ? "Penutupan akaun" : locale === "zh" ? "关闭账户" : locale === "ko" ? "계정 해지" : "Account closure");
    expect(s).not.toMatch(/Siti|\+60|siti@/);
    expect(errors).toEqual([]);
  });

  it("warns when a period held more than the report reads, and says there is nothing to show for an empty one", () => {
    const warn = text(page(locale, <ReportBody report={{ ...report, truncated: true }} />));
    expect(warn).toContain(t("reports")("truncated", { count: 5000 }));
    const empty = text(page(locale, <ReportBody report={{ ...report, total: 0, open: 0, finished: 0, byType: [], signoffs: [], rejections: [], clock: { considered: 0, withinTarget: 0, afterTarget: 0, afterStop: 0, openPastStop: 0 } }} />));
    expect(empty).toContain(t("reports")("clock.none"));
    expect(empty).toContain(t("reports")("none"));
  });

  it("shows a public form's settings: on/off, the address to share, the notice per language, Turnstile, the maximum, the banks", () => {
    const html = page(locale, <PublicFormCard form={form({ typeKey: "withdrawal", slug: "withdraw-funds-xyz23456", maxAmount: 5000, banks: ["Maybank", "CIMB Bank"] })} turnstileAvailable onSaved={() => undefined} origin="https://halo.example" />);
    const s = text(html);
    const p = t("settings.publicForms");
    for (const k of ["types.withdrawal", "isOn", "enable", "address", "copy", "open", "newAddress", "notice", "noticeHint", "turnstile", "maxAmount", "banks", "banksHint"]) expect(s, k).toContain(p(k));
    for (const l of ["en", "ms", "zh", "ko"]) expect(s).toContain(p(`languages.${l}`));
    expect(html).toContain("https://halo.example/c/withdraw-funds-xyz23456");
    expect(html).toContain("Maybank\nCIMB Bank");
    expect(html).toContain('lang="zh"');
  });

  it("says why a form cannot be switched on, and why Turnstile cannot be chosen when the operator has not set its keys", () => {
    const html = page(locale, <PublicFormCard form={form({ ready: false, enabled: false, exists: false, slug: null })} turnstileAvailable={false} onSaved={() => undefined} origin="https://halo.example" />);
    const s = text(html);
    const p = t("settings.publicForms");
    expect(s).toContain(p("notReady"));
    expect(s).toContain(p("turnstileMissing"));
    expect(s).toContain(p("noAddress"));
    expect(html).not.toContain("/c/");
    expect(html).toMatch(/id="cmp-pf-closure-enabled"[^>]*disabled/);
  });

  it("shows the sidebar badge: a number with its words, '9+' from ten, nothing at zero", () => {
    const b = t("badge");
    const three = page(locale, <ComplianceWaitingBadge count={3} />);
    expect(three).toContain(">3<");
    expect(three).toContain(`aria-label="${b("waiting", { count: 3 })}"`);
    expect(page(locale, <ComplianceWaitingBadge count={12} />)).toContain(">9+<");
    expect(page(locale, <ComplianceWaitingBadge count={0} />)).toBe("");
  });
});

describe("the pure helpers behind the Part B screens", () => {
  it("builds the address a form is shared at and reads the maximum amount", () => {
    expect(formUrl("https://halo.example/", "close-abc23456")).toBe("https://halo.example/c/close-abc23456");
    expect(parseMaxAmount("1,000")).toBe(1000);
    expect(parseMaxAmount("5000.50")).toBe(5000.5);
    for (const v of ["", "0", "-1", "1.234", "abc", "1e3", "100000001"]) expect(parseMaxAmount(v), v).toBeNull();
  });

  it("targets a conversation or a ticket, not both", () => {
    expect(targetOf("cv", null)).toEqual({ conversationId: "cv" });
    expect(targetOf(null, "tk")).toEqual({ ticketId: "tk" });
    expect(targetOf(undefined, undefined)).toBeNull();
  });

  it("works out the report presets in local days and checks a range", () => {
    const today = new Date(2026, 9, 13);
    expect(dayString(today)).toBe("2026-10-13");
    expect(presetRange("last30", today)).toEqual({ from: "2026-09-14", to: "2026-10-13" });
    expect(presetRange("last90", today)).toEqual({ from: "2026-07-16", to: "2026-10-13" });
    expect(presetRange("thisYear", today)).toEqual({ from: "2026-01-01", to: "2026-10-13" });
    expect(presetRange("all", today)).toEqual({ from: "", to: "" });
    expect(PRESETS).toContain("custom");
    expect(rangeValid("2026-01-01", "2026-02-01")).toBe(true);
    expect(rangeValid("", "")).toBe(true);
    expect(rangeValid("2026-02-02", "2026-02-01")).toBe(false);
    expect(rangeValid("2026-13-45", "")).toBe(false);
    expect(rangeValid("soon", "")).toBe(false);
  });

  it("makes shares and day figures", () => {
    expect(percent(5, 8)).toBe(63);
    expect(percent(1, 0)).toBe(0);
    expect(days(4.5, "en")).toBe("4.5");
    expect(days(null, "en")).toBe("–");
    expect(days(Number.NaN, "en")).toBe("–");
  });
});
