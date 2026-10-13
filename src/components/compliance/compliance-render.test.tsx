import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Render tests for Compliance requests in every language, with the real wording from messages/<locale>.json. next-intl is told to throw on a missing key or
// argument instead of printing a raw key path. renderToStaticMarkup paints the FIRST render only (effects, timers, fetches and event handlers do not run),
// so what is checked here is what each state looks like: the list row with its clock chips, the step bar, every panel masked and revealed, the sign-off
// with its disabled explanations, the checklist, the files, the links, the timeline, the settings and the New request form.
// NOT covered (no DOM renderer): clicking, typing and focus movement, the reveal countdown and the page-hidden listener, the file picker, the real fetches,
// the phone layout and the dark appearance. See docs/compliance-requests.md.

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "u1", email: "officer@example.test" }, profile: { full_name: "Olivia Officer", email: "officer@example.test" }, capabilities: new Set(["menu.compliance"]), refreshCapabilities: () => undefined }),
  useCapability: () => true,
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => undefined }) }));

import { computeClock, DAY_MS } from "@/lib/compliance/clock";
import { typeFromRow } from "@/lib/compliance/service/rows";
import { TYPE_ROWS } from "@/lib/compliance/test-support";
import type { RequestDetail, RequestEvent, RequestStatus, RequestSummary, Viewer } from "@/lib/compliance/types";

import { AnswersPanel, ClockPanel, CloseWithoutDecision, CustomerPanel, ExecutionPanel, FilesPanel, IdentityPanel, LinksPanel, ReviewPanel, SensitivePanel, SignoffPanel, StandingPanel, TimelinePanel } from "./detail-panels";
import { ComplianceScreen } from "./compliance-screen";
import { NewRequest } from "./new-request";
import { ClockCell, ClockChip, ClockText, StatusChip, StepBar, TypeChip } from "./parts";
import { NewTypeForm, TypeEditor } from "./settings";

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
afterEach(() => {
  vi.restoreAllMocks();
});

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

// ---- fixtures ----------------------------------------------------------------------------------------------------------

const NOW = Date.parse("2026-10-12T12:00:00Z");
const day = (n: number) => new Date(NOW - n * DAY_MS).toISOString();
const closureType = typeFromRow(TYPE_ROWS[0]);

const viewer = (over: Partial<Viewer> = {}): Viewer => ({ userId: "u1", canReview: true, canApprove: false, canReveal: false, canExecute: false, canManage: false, ...over });

const summary = (over: Partial<RequestSummary> = {}): RequestSummary => ({
  id: "r1",
  reference: "CMP-2026-000014",
  typeKey: "closure",
  typeLabel: "Account closure",
  typeLabelL10n: { ms: "Penutupan akaun", zh: "关闭账户", ko: "계정 해지" },
  status: "officer_review",
  customerName: "Siti Aminah",
  customerEmail: "siti@example.test",
  customerPhone: "+60123456789",
  receivedAt: day(8),
  targetDays: 14,
  hardStopDays: 30,
  targetDueAt: new Date(NOW + 6 * DAY_MS).toISOString(),
  hardStopAt: new Date(NOW + 22 * DAY_MS - 3_600_000).toISOString(),
  pausedAt: null,
  completedAt: null,
  closedAt: null,
  assignedTo: { id: "u2", name: "Harun Head" },
  source: "staff",
  isTest: false,
  ...over,
});

const detail = (over: Partial<RequestDetail> = {}): RequestDetail => ({
  ...summary(),
  channel: "whatsapp",
  customerLocale: null,
  emailVerifiedAt: null,
  notices: [],
  type: closureType,
  data: { confirm_closure: true, children_finished_school: true, allowances_cancelled: false, reason: "Moving abroad" },
  sensitive: [
    { key: "bank_name", label: { en: "Bank name", ms: "Nama bank", zh: "银行名称", ko: "은행 이름" }, type: "text", masked: "•••• erhad", present: true },
    { key: "bank_account_number", label: { en: "Bank account number", ms: "Nombor akaun bank", zh: "银行账号", ko: "은행 계좌 번호" }, type: "text", masked: "•••• 9012", present: true },
    { key: "bank_account_holder", label: { en: "Bank account holder name" }, type: "text", masked: "", present: false },
  ],
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
  createdBy: { id: "u1", name: "Olivia Officer" },
  viewer: viewer(),
  ...over,
});

const props = (d: RequestDetail) => ({ d, act: noop, busy: false, now: NOW });

describe.each(LOCALES)("Compliance requests in %s", (locale) => {
  const t = tr(locale, "Compliance");

  // ---- the list ------------------------------------------------------------------------------------------------------

  it("shows a list row's clock as an amber or red chip WITH words, and 'Day N of 14 target · N days to stop'", () => {
    const cases: [Partial<RequestSummary>, string, string][] = [
      [{ receivedAt: day(2), targetDueAt: new Date(NOW + 12 * DAY_MS).toISOString(), hardStopAt: new Date(NOW + 28 * DAY_MS).toISOString() }, "on_track", "ok"],
      [{ receivedAt: day(16), targetDueAt: new Date(NOW - 2 * DAY_MS).toISOString(), hardStopAt: new Date(NOW + 14 * DAY_MS).toISOString() }, "target_passed", "amber"],
      [{ receivedAt: day(24), targetDueAt: new Date(NOW - 10 * DAY_MS).toISOString(), hardStopAt: new Date(NOW + 6 * DAY_MS).toISOString() }, "near_stop", "red"],
      [{ receivedAt: day(33), targetDueAt: new Date(NOW - 19 * DAY_MS).toISOString(), hardStopAt: new Date(NOW - 3 * DAY_MS).toISOString() }, "breached", "red"],
      [{ pausedAt: day(1) }, "paused", "grey"],
      [{ status: "closed", closedAt: day(1) }, "done", "grey"],
    ];
    for (const [over, state, level] of cases) {
      const html = page(locale, <ClockCell request={summary(over)} now={NOW} />);
      expect(html, state).toContain(`data-clock="${state}"`);
      expect(html, state).toContain(`data-level="${level}"`);
      expect(html, state).toContain("<svg");
      expect(text(html), state).toContain(tr(locale, "Compliance.clock.state")(state));
    }
    // the closure example from the brief
    const nine = page(locale, <ClockCell request={summary({ receivedAt: day(8), hardStopAt: new Date(NOW + 21 * DAY_MS).toISOString(), targetDueAt: new Date(NOW + 6 * DAY_MS).toISOString() })} now={NOW} />);
    const c = tr(locale, "Compliance.clock");
    expect(text(nine)).toContain(`${c("dayOf", { day: 9, target: 14 })} · ${c("toStop", { count: 21 })}`);
  });

  it("words a breach with the days over the stop, and a finished case with how long it took", () => {
    const c = tr(locale, "Compliance.clock");
    const breached = page(locale, <ClockCell request={summary({ receivedAt: day(33), targetDueAt: new Date(NOW - 19 * DAY_MS).toISOString(), hardStopAt: new Date(NOW - 3 * DAY_MS).toISOString() })} now={NOW} />);
    expect(text(breached)).toContain(c("overStop", { count: 3 }));
    const done = page(locale, <ClockCell request={summary({ status: "closed", receivedAt: day(12), completedAt: day(1), closedAt: day(0) })} now={NOW} />);
    expect(text(done)).toContain(c("done", { days: 12 }));
  });

  it("marks the status, the type and a test case", () => {
    for (const s of ["received", "identity_check", "officer_review", "awaiting_signoff", "approved", "rejected", "executing", "completed", "closed"] as RequestStatus[]) {
      const html = page(locale, <StatusChip status={s} />);
      expect(html).toContain(`data-status="${s}"`);
      expect(text(html)).toContain(tr(locale, "Compliance.status")(s));
    }
    expect(text(page(locale, <TypeChip request={summary()} />))).toContain(locale === "en" ? "Account closure" : (summary().typeLabelL10n as Record<string, string>)[locale]);
    const view = computeClock({ status: "officer_review", receivedAt: day(1), targetDays: null, hardStopDays: null, targetDueAt: null, hardStopAt: null, pausedAt: null }, NOW);
    expect(text(page(locale, <><ClockChip view={view} /><ClockText view={view} /></>))).toContain(tr(locale, "Compliance.clock.state")("none"));
  });

  it("paints the list screen's first state: title, the seven counts, the filters and the footer", () => {
    const html = page(locale, <ComplianceScreen />);
    const s = text(html);
    expect(s).toContain(t("title"));
    for (const k of ["needsIdentityCheck", "inReview", "awaitingSignoff", "executing", "pastTarget", "nearStop", "breached"]) expect(s, k).toContain(tr(locale, "Compliance.counts")(k));
    expect(html).toContain('role="search"');
    expect(s).toContain(t("filters.clear") === "" ? "" : tr(locale, "Compliance.filters")("allTypes"));
    expect(s).toContain(t("footer"));
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(7);
    expect(errors).toEqual([]);
  });

  // ---- the step bar ----------------------------------------------------------------------------------------------------

  it("shows where the case is on the six-step bar, with words for done, current and rejected", () => {
    const steps = tr(locale, "Compliance.steps");
    const at = (status: RequestStatus) => {
      const html = page(locale, <StepBar status={status} />);
      return [...html.matchAll(/data-step="(\w+)" data-state="(\w+)"/g)].map((m) => `${m[1]}:${m[2]}`);
    };
    expect(at("received")).toEqual(["received:current", "identity_check:todo", "officer_review:todo", "signoff:todo", "execution:todo", "closed:todo"]);
    expect(at("awaiting_signoff")).toEqual(["received:done", "identity_check:done", "officer_review:done", "signoff:current", "execution:todo", "closed:todo"]);
    expect(at("executing")).toEqual(["received:done", "identity_check:done", "officer_review:done", "signoff:done", "execution:current", "closed:todo"]);
    expect(at("closed").every((x) => x.endsWith(":done"))).toBe(true);
    const html = page(locale, <StepBar status="rejected" />);
    expect(html).toContain('aria-current="step"');
    expect(text(html)).toContain(`(${steps("rejected")})`);
    for (const s of ["received", "identity_check", "officer_review", "signoff", "execution", "closed"]) expect(text(html)).toContain(steps(s));
  });

  // ---- bank details: masked, then revealed ------------------------------------------------------------------------------

  it("shows bank details masked, with Reveal only for a person who may, and never the value", () => {
    const secret = "8800123456789012";
    const masked = page(locale, <SensitivePanel {...props(detail({ viewer: viewer({ canReveal: true }) }))} revealed={null} onRevealed={() => undefined} onHide={() => undefined} />);
    const s = tr(locale, "Compliance.sensitive");
    expect(masked).toContain("•••• 9012");
    expect(masked).toContain('data-masked="true"');
    expect(masked).not.toContain(secret);
    expect(text(masked)).toContain(s("reveal"));
    expect(text(masked)).toContain(s("notGiven"));
    expect(text(masked)).toContain(s("revealHint"));
    const noPermission = page(locale, <SensitivePanel {...props(detail())} revealed={null} onRevealed={() => undefined} onHide={() => undefined} />);
    expect(text(noPermission)).not.toContain(`${s("reveal")} `);
    expect(text(noPermission)).toContain(s("noReveal"));
    expect(noPermission).not.toContain(secret);
  });

  it("shows the revealed values with the countdown and 'Hide now'; an expired reveal falls back to the mask", () => {
    const d = detail({ viewer: viewer({ canReveal: true }) });
    const result = { fields: [{ key: "bank_account_number", label: { en: "Bank account number" }, value: "8800123456789012" }, { key: "bank_name", label: { en: "Bank name" }, value: "Maybank Berhad" }], expiresInSeconds: 120 };
    const s = tr(locale, "Compliance.sensitive");
    const html = page(locale, <SensitivePanel {...props(d)} revealed={{ result, until: NOW + 90_000 }} onRevealed={() => undefined} onHide={() => undefined} />);
    expect(html).toContain('data-revealed="true"');
    expect(text(html)).toContain("8800123456789012");
    expect(text(html)).toContain("Maybank Berhad");
    expect(text(html)).toContain(s("hidesIn", { seconds: 90 }));
    expect(text(html)).toContain(s("hide"));
    const expired = page(locale, <SensitivePanel {...props(d)} revealed={{ result, until: NOW - 1 }} onRevealed={() => undefined} onHide={() => undefined} />);
    expect(expired).not.toContain("8800123456789012");
    expect(expired).toContain("•••• 9012");
  });

  it("warns when the stored details cannot be read (a key problem) and offers no Reveal", () => {
    const html = page(locale, <SensitivePanel {...props(detail({ sensitiveReadable: false, viewer: viewer({ canReveal: true }) }))} revealed={null} onRevealed={() => undefined} onHide={() => undefined} />);
    expect(html).toContain('role="alert"');
    expect(text(html)).toContain(tr(locale, "Compliance.sensitive")("unreadable"));
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it("shows nothing for a type with no sensitive fields", () => {
    expect(page(locale, <SensitivePanel {...props(detail({ sensitive: [] }))} revealed={null} onRevealed={() => undefined} onHide={() => undefined} />)).toBe("");
  });

  // ---- sign-off ---------------------------------------------------------------------------------------------------------

  it("disables Approve and Reject with the maker-checker explanation for the person who did the identity check", () => {
    const d = detail({ status: "awaiting_signoff", viewer: viewer({ canApprove: true, userId: "u1" }), identityCheck: { outcome: "pass", method: "call_back", verifiedBy: "u1", recordedBy: "u1" } });
    const html = page(locale, <SignoffPanel {...props(d)} />);
    const b = tr(locale, "Compliance.blocked");
    expect(text(html)).toContain(b("maker_checker"));
    expect(html).toContain('data-reason="maker_checker"');
    const approve = html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?<\/button>/g)!.filter((x) => text(x).includes(tr(locale, "Compliance.signoff")("approve")));
    expect(approve.length).toBeGreaterThan(0);
    expect(approve[0]).toContain("disabled");
  });

  it("enables Approve for someone else with the permission, and explains to a reviewer that only the Head signs off", () => {
    const base = detail({ status: "awaiting_signoff", identityCheck: { outcome: "pass", verifiedBy: "u9", recordedBy: "u9" } });
    const head = page(locale, <SignoffPanel {...props({ ...base, viewer: viewer({ canApprove: true }) })} />);
    expect(head).not.toContain("data-reason=");
    const officer = page(locale, <SignoffPanel {...props({ ...base, viewer: viewer({ canApprove: false }) })} />);
    expect(text(officer)).toContain(tr(locale, "Compliance.signoff")("onlyHead"));
    expect(text(officer)).toContain(tr(locale, "Compliance.blocked")("no_permission"));
  });

  it("asks for the override reason while dues are outstanding and blocks approval until it is typed", () => {
    const d = detail({ status: "awaiting_signoff", viewer: viewer({ canApprove: true }), identityCheck: { outcome: "pass", verifiedBy: "u9" }, standing: { duesOutstanding: true, source: "manual" } });
    const html = page(locale, <SignoffPanel {...props(d)} />);
    expect(text(html)).toContain(tr(locale, "Compliance.signoff")("overrideLabel"));
    expect(html).toContain('data-reason="dues_outstanding"');
    expect(text(html)).toContain(tr(locale, "Compliance.blocked")("dues_outstanding"));
  });

  it("blocks approval after a failed identity check, and shows a recorded decision with who and when", () => {
    const failed = page(locale, <SignoffPanel {...props(detail({ status: "awaiting_signoff", viewer: viewer({ canApprove: true }), identityCheck: { outcome: "fail", verifiedBy: "u9" } }))} />);
    expect(failed).toContain('data-reason="identity_not_passed"');
    const done = page(locale, <SignoffPanel {...props(detail({ status: "approved", signoff: { decision: "approved", by: "u2", at: "2026-10-10T08:00:00Z", reason: "Documents in order", overrideReason: "Settled in cash" } }))} />);
    expect(text(done)).toContain(tr(locale, "Compliance.signoff.decisions")("approved"));
    expect(text(done)).toContain("Documents in order");
    expect(text(done)).toContain("Settled in cash");
  });

  // ---- identity check, review, standing ---------------------------------------------------------------------------------

  it("offers the identity check form to a reviewer, and the explanation (not the form) to someone without the permission", () => {
    const id = tr(locale, "Compliance.identity");
    const form = page(locale, <IdentityPanel {...props(detail({ status: "received" }))} />);
    expect(text(form)).toContain(id("record"));
    for (const m of ["call_back", "video_call", "id_document", "chat_verification", "in_person", "other"]) expect(text(form)).toContain(tr(locale, "Compliance.identity.methods")(m));
    expect(text(form)).toContain(id("byYou"));
    expect(form).toMatch(/<button[^>]*disabled[^>]*>(?:(?!<\/button>)[\s\S])*?<\/button>/);
    const blocked = page(locale, <IdentityPanel {...props(detail({ status: "received", viewer: viewer({ canReview: false, canExecute: true }) }))} />);
    expect(text(blocked)).toContain(tr(locale, "Compliance.blocked")("no_permission"));
    expect(text(blocked)).not.toContain(id("record"));
  });

  it("shows a recorded identity check with the method, the result and who", () => {
    const d = detail({ status: "officer_review", identityCheck: { method: "other", methodOther: "Branch visit", outcome: "pass", verifiedBy: "u1", verifiedAt: "2026-10-09T08:00:00Z", notes: "Showed the card" }, events: [{ id: "e1", kind: "identity_check", at: "2026-10-09T08:00:00Z", actor: { id: "u1", name: "Olivia Officer" }, detail: {} }] });
    const html = page(locale, <IdentityPanel {...props(d)} />);
    expect(text(html)).toContain("Branch visit");
    expect(text(html)).toContain(tr(locale, "Compliance.identity.outcomes")("pass"));
    expect(text(html)).toContain("Olivia Officer");
    expect(text(html)).toContain("Showed the card");
  });

  it("offers the recommendation form in officer review and shows the record afterwards", () => {
    const r = tr(locale, "Compliance.review");
    const form = page(locale, <ReviewPanel {...props(detail({ status: "officer_review" }))} />);
    for (const k of ["approve", "reject", "more_info"]) expect(text(form)).toContain(tr(locale, "Compliance.review.recommendations")(k));
    expect(text(form)).toContain(r("submit"));
    const done = page(locale, <ReviewPanel {...props(detail({ status: "awaiting_signoff", review: { recommendation: "approve", notes: "All good", by: "u1", at: "2026-10-09T09:00:00Z" } }))} />);
    expect(text(done)).toContain("All good");
    expect(text(done)).not.toContain(r("submit"));
    expect(text(page(locale, <ReviewPanel {...props(detail({ status: "received" }))} />))).toContain(r("notYet"));
  });

  it("shows the dues block only for a type that checks dues, with the manual note", () => {
    const html = page(locale, <StandingPanel {...props(detail({ status: "officer_review", standing: { duesOutstanding: true, notes: "Two allowances", source: "manual", setBy: "u1", setAt: "2026-10-09T09:00:00Z" } }))} />);
    const s = tr(locale, "Compliance.standing");
    expect(text(html)).toContain(s("title"));
    expect(text(html)).toContain(s("blocksApproval"));
    expect(text(html)).toContain(tr(locale, "Compliance")("notConnected", { what: s("backOffice") }));
    const decided = page(locale, <StandingPanel {...props(detail({ status: "approved", standing: { duesOutstanding: true, notes: "Two allowances", source: "manual", setBy: "u1", setAt: "2026-10-09T09:00:00Z" } }))} />);
    expect(text(decided)).toContain("Two allowances");
    expect(text(decided)).toContain(s("sourceManual"));
    expect(page(locale, <StandingPanel {...props(detail({ type: typeFromRow(TYPE_ROWS[1]) }))} />)).toBe("");
  });

  // ---- execution, close, pause --------------------------------------------------------------------------------------------

  it("shows the checklist with who and when; ticks are for the operations permission only; Complete waits for every step", () => {
    const e = tr(locale, "Compliance.execution");
    const checklist = [
      { stepKey: "close_in_backoffice", label: "Close the account in the back office", labelL10n: { en: "Close the account in the back office" }, position: 0, done: true, doneBy: { id: "u3", name: "Omar Ops" }, doneAt: "2026-10-11T10:00:00Z", note: null },
      { stepKey: "refund", label: "Refund the balance", labelL10n: { en: "Refund the balance" }, position: 1, done: false, doneBy: null, doneAt: null, note: null },
    ];
    const ops = page(locale, <ExecutionPanel {...props(detail({ status: "executing", checklist, viewer: viewer({ canReview: false, canExecute: true }) }))} />);
    expect(text(ops)).toContain("Omar Ops");
    expect(text(ops)).toContain(e("doneBy"));
    expect(text(ops)).toContain(tr(locale, "Compliance.blocked")("checklist_incomplete"));
    expect(ops).toContain('data-reason="checklist_incomplete"');
    expect(ops).toMatch(/type="checkbox"[^>]*checked/);
    expect(ops).not.toMatch(/id="cmp-step-refund"[^>]*disabled/);
    const reviewerOnly = page(locale, <ExecutionPanel {...props(detail({ status: "executing", checklist }))} />);
    expect(reviewerOnly).toMatch(/id="cmp-step-refund"[^>]*disabled/);
    expect(text(reviewerOnly)).toContain(e("onlyOperations"));
  });

  it("offers closing a completed or rejected case, and 'close without a decision' only before the sign-off", () => {
    const e = tr(locale, "Compliance.execution");
    expect(text(page(locale, <ExecutionPanel {...props(detail({ status: "completed" }))} />))).toContain(e("closeCompleted"));
    expect(text(page(locale, <ExecutionPanel {...props(detail({ status: "rejected" }))} />))).toContain(e("closeRejected"));
    expect(text(page(locale, <CloseWithoutDecision {...props(detail({ status: "received" }))} />))).toContain(e("closeWithoutDecision"));
    expect(page(locale, <CloseWithoutDecision {...props(detail({ status: "awaiting_signoff" }))} />)).toBe("");
  });

  it("shows the pause control only to the Head, on a type that allows it, with a clock", () => {
    const allowing = { ...closureType, allowPause: true };
    const head = page(locale, <ClockPanel {...props(detail({ type: allowing, viewer: viewer({ canApprove: true }) }))} />);
    expect(text(head)).toContain(tr(locale, "Compliance.clockPanel")("pause"));
    expect(page(locale, <ClockPanel {...props(detail({ type: allowing, viewer: viewer({ canApprove: false }) }))} />)).toBe("");
    expect(page(locale, <ClockPanel {...props(detail({ viewer: viewer({ canApprove: true }) }))} />)).toBe("");
    const paused = page(locale, <ClockPanel {...props(detail({ type: allowing, pausedAt: day(1), viewer: viewer({ canApprove: true }) }))} />);
    expect(text(paused)).toContain(tr(locale, "Compliance.clockPanel")("resume"));
  });

  // ---- customer, answers, files, links, timeline -----------------------------------------------------------------------------

  it("shows the customer and the answers in the person's language, ticks as yes and no, and Edit only while editable", () => {
    const c = page(locale, <CustomerPanel {...props(detail())} />);
    expect(text(c)).toContain("Siti Aminah");
    expect(text(c)).toContain("+60123456789");
    expect(text(c)).toContain(tr(locale, "Compliance.customer.sources")("staff"));
    expect(text(c)).toContain(tr(locale, "Compliance.customer")("edit"));
    expect(text(page(locale, <CustomerPanel {...props(detail({ status: "approved" }))} />))).not.toContain(`>${tr(locale, "Compliance.customer")("edit")}<`);
    const a = page(locale, <AnswersPanel {...props(detail())} />);
    expect(text(a)).toContain("Moving abroad");
    expect(text(a)).toContain(locale === "en" ? "I confirm I want to close this account" : `I confirm I want to close this account (${locale})`);
    expect(text(a)).toContain(tr(locale, "Compliance")("yes"));
    expect(text(a)).toContain(tr(locale, "Compliance")("no"));
    expect(a).not.toContain("bank_account_number");
  });

  it("lists the files with a download link, and the documents the type expects", () => {
    const f = tr(locale, "Compliance.files");
    const d = detail({ viewer: viewer({ canApprove: true }), files: [{ id: "f1", name: "letter.pdf", mime: "application/pdf", size: 52_000, fieldKey: "authorization_letter", uploadedBy: { id: "u1", name: "Olivia Officer" }, uploadedAt: "2026-10-09T10:00:00Z" }] });
    const html = page(locale, <FilesPanel {...props(d)} />);
    expect(html).toContain('href="/api/compliance/requests/r1/files/f1"');
    expect(html).toContain("download");
    expect(text(html)).toContain("letter.pdf");
    expect(text(html)).toContain(f("haveCount", { count: 1 }));
    expect(text(html)).toContain(f("rules"));
    expect(html).not.toContain("account-");
    const none = page(locale, <FilesPanel {...props(detail())} />);
    expect(text(none)).toContain(f("missing"));
    const noOpen = page(locale, <FilesPanel {...props({ ...d, viewer: viewer({ canReview: false, canApprove: false, canExecute: true }) })} />);
    expect(noOpen).not.toContain("href=\"/api/compliance");
  });

  it("shows the links with Open buttons that go to the ticket, the incident and the contact", () => {
    const l = tr(locale, "Compliance.links");
    const d = detail({ links: { contact: { id: "c1", name: "Siti Aminah" }, conversationId: "v1", ticket: { id: "t1", number: 412, subject: "Close my account" }, incident: { id: "i1", number: 7, title: "Wrong refund" }, kycValidationRef: "val_123" } });
    const html = page(locale, <LinksPanel {...props(d)} />);
    for (const href of ["/contacts?contact=c1", "/inbox?c=v1", "/tickets/t1", "/incidents/i1", "/kyc"]) expect(html, href).toContain(`href="${href}"`);
    expect(text(html)).toContain("#412 Close my account");
    expect(text(html)).toContain(l("unlink"));
    expect(text(page(locale, <LinksPanel {...props(detail())} />))).toContain(l("none"));
    const readOnly = page(locale, <LinksPanel {...props({ ...d, viewer: viewer({ canReview: false, canExecute: true }) })} />);
    expect(text(readOnly)).not.toContain(l("unlink"));
  });

  it("writes the timeline in words, newest first, and folds a person's repeated opens into one line", () => {
    const k = tr(locale, "Compliance.timeline.kinds");
    const ev = (id: string, kind: RequestEvent["kind"], at: string, detailBag: Record<string, unknown> = {}, actor = { id: "u1", name: "Olivia Officer" }): RequestEvent => ({ id, kind, at, actor, detail: detailBag });
    const events: RequestEvent[] = [
      ev("e5", "view", "2026-10-12T10:05:00Z"),
      ev("e4", "view", "2026-10-12T10:03:00Z"),
      ev("e3", "view", "2026-10-12T10:01:00Z"),
      ev("e2", "status", "2026-10-12T09:00:00Z", { from: "received", to: "officer_review", note: "Called back" }),
      ev("e1", "created", "2026-10-04T08:00:00Z", { source: "staff", backdated: true }, { id: "u1", name: "Olivia Officer" }),
    ];
    const html = page(locale, <TimelinePanel {...props(detail({ events, viewer: viewer({ canReview: true }) }))} />);
    const s = text(html);
    expect(s).toContain(k("view_many", { count: 3 }));
    expect(s).toContain("Called back");
    expect(s).toContain(k("status", { from: tr(locale, "Compliance.status")("received"), to: tr(locale, "Compliance.status")("officer_review") }));
    expect(s).toContain(k("created_backdated", { source: tr(locale, "Compliance.customer.sources")("staff") }));
    expect(s.indexOf(k("view_many", { count: 3 }))).toBeLessThan(s.indexOf("Called back"));
    expect(html.match(/<li class="border-l-2/g)).toHaveLength(3);
    expect(text(page(locale, <TimelinePanel {...props(detail({ events, viewer: viewer({ canReview: false, canExecute: true }) }))} />))).not.toContain(tr(locale, "Compliance.timeline")("saveNote"));
  });

  // ---- New request, settings --------------------------------------------------------------------------------------------------

  it("renders the New request form from the type: required marks, the encrypted note on bank fields, the file field deferred, Create disabled", () => {
    const n = tr(locale, "Compliance.new");
    const html = page(locale, <NewRequest types={[closureType, typeFromRow(TYPE_ROWS[2])]} onCreated={() => undefined} onCancel={() => undefined} />);
    const s = text(html);
    expect(s).toContain(n("title"));
    expect(s).toContain(n("intro"));
    expect(s).toContain(tr(locale, "Compliance.form")("encrypted"));
    expect(s).toContain(tr(locale, "Compliance.form")("fileLater"));
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('type="datetime-local"');
    expect(html).toMatch(/<button[^>]*disabled[^>]*type="submit"|<button[^>]*type="submit"[^>]*disabled/);
    expect(s).toContain(n("requiredHint", { count: 7 }));
    expect(text(page(locale, <NewRequest types={[]} onCreated={() => undefined} onCancel={() => undefined} />))).toContain(n("noTypes"));
  });

  it("renders the settings editor for a standard type (fields read-only) and a form for a new one", () => {
    const st = tr(locale, "Compliance.settings");
    const html = page(locale, <TypeEditor type={closureType} onSaved={() => undefined} />);
    const s = text(html);
    expect(s).toContain(st("standard"));
    expect(s).toContain(st("clocks"));
    expect(s).toContain(st("fieldsFixed"));
    expect(s).toContain(st("switches.identityCheck"));
    expect(html).toMatch(/id="cmp-type-closure-target"[^>]*value="14"/);
    expect(html).toMatch(/id="cmp-type-closure-stop"[^>]*value="30"/);
    expect(html.match(/data-slot="input"/g)!.length).toBeGreaterThan(8);
    expect(html).not.toContain("Remove field");
    const custom = page(locale, <TypeEditor type={{ ...typeFromRow(TYPE_ROWS[2]), isSystem: false, key: "address_change" }} onSaved={() => undefined} />);
    expect(text(custom)).toContain(st("addField"));
    expect(text(custom)).not.toContain(st("fieldsFixed"));
    expect(text(page(locale, <NewTypeForm onCreated={() => undefined} onCancel={() => undefined} />))).toContain(st("keyWillBe"));
  });

  it("words every error code in this language", () => {
    const errs = (CATALOGUES[locale].Compliance as { errors: Record<string, string> }).errors;
    const en = (CATALOGUES.en.Compliance as { errors: Record<string, string> }).errors;
    expect(Object.keys(errs).sort()).toEqual(Object.keys(en).sort());
    for (const v of Object.values(errs)) expect(v.trim().length).toBeGreaterThan(5);
  });

  it("words the permissions, the menu and the platform switch", () => {
    const m = CATALOGUES[locale] as unknown as { Sidebar: Record<string, string>; Header: Record<string, string>; Settings: { sections: Record<string, string> }; Permissions: { cap: Record<string, { label: string; description: string }>; group: Record<string, string> }; Platform: Record<string, string> };
    expect(m.Sidebar.compliance.length).toBeGreaterThan(1);
    expect(m.Header.compliance.length).toBeGreaterThan(1);
    expect(m.Settings.sections.compliance.length).toBeGreaterThan(1);
    expect(m.Permissions.group.compliance.length).toBeGreaterThan(1);
    for (const id of ["menu_compliance", "compliance_review", "compliance_approve", "compliance_reveal", "compliance_execute", "compliance_manage"]) {
      expect(m.Permissions.cap[id].label.length, id).toBeGreaterThan(3);
      expect(m.Permissions.cap[id].description.length, id).toBeGreaterThan(30);
    }
    expect(m.Platform.feature_compliance.length).toBeGreaterThan(3);
    expect(m.Platform.feature_compliance_desc.length).toBeGreaterThan(30);
  });
});

// ---- the source of the screens ---------------------------------------------------------------------------------------------------

describe("the screens' source", () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : [join(dir, n)]));
  const root = process.cwd();
  const ui = files(join(root, "src", "components", "compliance")).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f));
  const read = (f: string) => readFileSync(f, "utf8");

  it("uses no Tailwind dark: variants (they do not work in this app); colours are tokens or light-dark() pairs", () => {
    for (const f of ui) expect(read(f), f).not.toMatch(/(^|[\s"'`])dark:/);
  });

  it("imports no Node-only module and no server module into the browser code", () => {
    for (const f of ui) {
      expect(read(f), f).not.toMatch(/from ["']node:|from ["'](fs|path|crypto|net|dns|child_process)["']/);
      expect(read(f), f).not.toMatch(/@\/lib\/compliance\/(secrets|errors|http|routes-support|service\/(?!rows))/);
      expect(read(f), f).not.toMatch(/process\.env/);
    }
  });

  it("never reads a sensitive value from anywhere but the reveal answer", () => {
    for (const f of ui) expect(read(f), f).not.toMatch(/data_enc|dataEnc/);
  });
});
