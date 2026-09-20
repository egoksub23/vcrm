import { readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";

import type { BulkProgress, BulkProposal } from "@/hooks/use-jira-bulk";
import type { TicketJira } from "@/hooks/use-ticket-jira";
import type { TicketJiraLinkRow } from "@/lib/jira/types";
import type { TicketAttachment } from "@/types";
import { BulkProgressView, BulkReviewList, JiraBulkCreateDialog, JiraBulkLinkDialog } from "./jira-bulk-dialogs";
import { TicketJiraCompactRow } from "./jira-compact-row";
import { JiraCreateForm, EMPTY_CREATE_CHOICES, type JiraCreateFormProps } from "./jira-create-dialog";
import { TicketAttachmentsSection } from "./ticket-attachments";
import { TicketJiraSection } from "./ticket-jira-section";

// Render smoke tests for the 0.45.0 ticket-side pieces (bulk dialogs, compact
// links, attachment actions, the create preview with mapped fields), in English
// and Korean with the real translations. next-intl errors are thrown, so a key
// missing from the catalogue fails here instead of showing a raw path.

const load = (locale: string) => JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8"));

function render(locale: string, node: React.ReactElement): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={load(locale)}
      timeZone="UTC"
      onError={(e: Error) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const NOW = new Date("2026-09-20T12:00:00Z");
const ok = async () => ({ ok: true as const, status: 200, data: {} as never });

const link = (over: Partial<TicketJiraLinkRow> = {}): TicketJiraLinkRow => ({
  id: "l1",
  account_id: "a",
  ticket_id: "t1",
  connection_id: "c1",
  issue_id: "10001",
  issue_key: "ENG-1",
  project_key: "ENG",
  project_name: "Engineering",
  issue_type: "Bug",
  summary: "Checkout fails",
  status_id: "3",
  status_name: "In Progress",
  status_category: "indeterminate",
  resolution: null,
  priority_name: "High",
  assignee_account_id: null,
  assignee_name: null,
  reporter_name: null,
  issue_url: "https://acme.atlassian.net/browse/ENG-1",
  jira_updated_at: "2026-09-20T11:00:00Z",
  last_synced_at: "2026-09-20T11:57:00Z",
  sync_state: "ok",
  sync_error: null,
  last_written: {},
  last_push: null,
  remote_link_id: null,
  linked_by: "u1",
  last_resync_at: null,
  created_at: "2026-09-20T10:00:00Z",
  updated_at: "2026-09-20T11:57:00Z",
  ...over,
});

const PROPOSALS: BulkProposal[] = [
  { ticketId: "t1", ticketKey: "VIR-1", subject: "Login fails", projectKey: "ENG", issueTypeId: "10004", issueTypeName: "Bug", summary: "Login fails", canCreate: true },
  { ticketId: "t2", ticketKey: "VIR-2", subject: "Refund", projectKey: "ENG", issueTypeId: "10004", issueTypeName: "Bug", summary: "Refund", canCreate: false, reason: "unsupported_fields", fields: ["Fix versions"] },
  { ticketId: "t3", ticketKey: "VIR-3", subject: "Invoice", projectKey: "ENG", issueTypeId: "10004", issueTypeName: "Bug", summary: "Invoice", canCreate: false, reason: "required_fields", fields: ["Severity note"] },
  { ticketId: "t4", ticketKey: "VIR-4", subject: "Crash", projectKey: "ENG", issueTypeId: "10004", issueTypeName: "Bug", summary: "Crash", canCreate: false, reason: "link_limit" },
  { ticketId: "t5", ticketKey: "VIR-5", subject: "Gone", projectKey: "ENG", issueTypeId: "10004", issueTypeName: null, summary: "", canCreate: false, reason: "not_found" },
];

const PROGRESS: BulkProgress = {
  batchId: "b1",
  kind: "create",
  total: 4,
  counts: { pending: 1, running: 0, done: 1, failed: 1, skipped: 1 },
  finished: false,
  targetIssueKey: null,
  items: [
    { id: "i1", ticket_id: "t1", status: "done", issue_key: "ENG-101", code: null, message: null, summary: "Login fails", project_key: "ENG" },
    { id: "i2", ticket_id: "t2", status: "failed", issue_key: null, code: "no_permission", message: "x", summary: null, project_key: "ENG" },
    { id: "i3", ticket_id: "t3", status: "skipped", issue_key: null, code: "already_linked", message: null, summary: null, project_key: "ENG" },
    { id: "i4", ticket_id: "t4", status: "pending", issue_key: null, code: null, message: null, summary: null, project_key: "ENG" },
  ],
};

describe.each(["en", "ko"])("0.45.0 ticket pieces (%s)", (locale) => {
  const m = () => load(locale);

  it("the bulk review lists each ticket with project, type and summary, and says why one cannot be created", () => {
    const html = render(locale, <BulkReviewList proposals={PROPOSALS} />);
    for (const k of ["VIR-1", "VIR-2", "VIR-5", "Login fails"]) expect(html).toContain(k);
    expect(html).toContain("ENG · Bug");
    expect(html).toContain(m().Jira.bulk.create.willCreate);
    expect(html).toContain(m().Jira.bulk.create.cannot);
    expect(html).toContain(m().Jira.bulk.reasons.unsupported_fields.replace("{fields}", "Fix versions"));
    expect(html).toContain(m().Jira.bulk.reasons.required_fields.replace("{fields}", "Severity note"));
    expect(html).toContain(m().Jira.bulk.reasons.link_limit);
    expect(html).toContain(m().Jira.bulk.reasons.not_found);
  });

  it("the progress view shows the bar, the counts and a result per ticket, with a link to each created issue", () => {
    const html = render(locale, <BulkProgressView progress={PROGRESS} labelOf={(id) => `VIR-${id.slice(1)}`} siteUrl="https://acme.atlassian.net" />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="75"');
    expect(html).toContain(m().Jira.bulk.progress.background);
    expect(html).toContain('href="https://acme.atlassian.net/browse/ENG-101"');
    expect(html).toContain(m().Jira.errors.no_permission);
    expect(html).toContain(m().Jira.errors.already_linked);
    for (const s of ["done", "failed", "skipped", "pending"]) expect(html).toContain(m().Jira.bulk.progress.status[s]);
  });

  it("a finished batch shows the summary instead of the 'runs in the background' note", () => {
    const html = render(locale, <BulkProgressView progress={{ ...PROGRESS, finished: true, counts: { pending: 0, running: 0, done: 2, failed: 1, skipped: 1 } }} labelOf={(id) => id} />);
    expect(html).toContain(m().Jira.bulk.progress.summary.replace("{done}", "2").replace("{failed}", "1").replace("{skipped}", "1"));
    expect(html).not.toContain(m().Jira.bulk.progress.background);
  });

  it("the dialogs render nothing while closed, and every string their open bodies use exists", () => {
    const tickets = [{ id: "t1", key: "VIR-1", subject: "Login fails" }];
    const closed = render(locale, <div><JiraBulkCreateDialog open={false} onOpenChange={() => {}} tickets={tickets} /><JiraBulkLinkDialog open={false} onOpenChange={() => {}} tickets={tickets} /></div>);
    expect(closed).not.toContain("VIR-1");
    // The open bodies render in a portal (not in static markup), so their keys are checked here by name.
    const bulk = m().Jira.bulk;
    for (const k of ["createButton", "linkButton", "tooMany", "cancel", "close", "closeBackground"]) expect(bulk[k], `bulk.${k}`).toBeTruthy();
    for (const k of ["title", "description", "project", "issueType", "reviewHeading", "reviewHint", "loading", "willCreate", "cannot", "counts", "confirm", "starting"]) expect(bulk.create[k], `create.${k}`).toBeTruthy();
    for (const k of ["title", "description", "reference", "placeholder", "hint", "ticketsHeading", "limit", "confirm", "target", "starting"]) expect(bulk.link[k], `link.${k}`).toBeTruthy();
    for (const k of ["finished", "running", "summary", "background", "toast"]) expect(bulk.progress[k], `progress.${k}`).toBeTruthy();
    expect(m().Jira.attachments.sentToast).toBeTruthy();
    expect(render(locale, <BulkReviewList proposals={PROPOSALS.slice(0, 1)} />)).toContain("VIR-1");
  });

  it("with more than two linked issues the rest are one-line rows with a per-issue sync state, and open into the full card", () => {
    const links = [
      link({ id: "a", issue_key: "ENG-1" }),
      link({ id: "b", issue_key: "ENG-2" }),
      link({ id: "c", issue_key: "ENG-3", summary: "Third issue" }),
      link({ id: "d", issue_key: "ENG-4", sync_state: "paused" }),
      link({ id: "e", issue_key: "ENG-5", sync_state: "broken", sync_error: "not_found" }),
    ];
    const jira = {
      loading: false,
      links,
      connection: { id: "c1", status: "active", statusReason: null, siteName: "Acme", siteUrl: "https://acme.atlassian.net", settings: { projects: { allowed: [], default_project: null, default_issue_type: null }, project_overrides: {} } as never },
      connected: true,
      needsReconnect: false,
      commentsToJira: true,
      hasOkLink: true,
      atLimit: true,
      sharedNoteIds: new Set(),
      attachmentsEnabled: false,
      sentAttachmentIds: new Set(),
      skippedFiles: [{ id: "s1", filename: "run.exe", status: "skipped_type" as const, jiraUrl: "https://acme.atlassian.net/secure/attachment/1/run.exe" }],
      sendAttachment: ok as never,
      reload: async () => {},
      syncNow: ok as never,
      unlink: ok as never,
      listTransitions: (async () => ({ ok: true, status: 200, data: { transitions: [] } })) as never,
      transition: ok as never,
      commentInJira: ok as never,
      shareNote: ok as never,
    } satisfies TicketJira;
    const html = render(locale, <TicketJiraSection ticketId="t1" jira={jira} />);
    for (const k of ["ENG-1", "ENG-2", "ENG-3", "ENG-4", "ENG-5"]) expect(html).toContain(k);
    // the first two are full cards; the other three are compact buttons
    expect((html.match(/aria-expanded="false"/g) ?? []).length).toBe(3);
    expect(html).toContain(m().Jira.depth.syncState.paused);
    expect(html).toContain(m().Jira.depth.syncState.broken);
    expect(html).toContain(m().Jira.depth.compact.toggle.replace("{key}", "ENG-3"));
    // a file that was not copied is listed with a link to it in Jira
    expect(html).toContain("run.exe");
    expect(html).toContain(m().Jira.depth.skipped.reason.skipped_type);
    expect(html).toContain('href="https://acme.atlassian.net/secure/attachment/1/run.exe"');
  });

  it("the compact row shows key, summary, status and 'synced N minutes ago'", () => {
    const html = render(locale, <TicketJiraCompactRow link={link()} expanded={false} onToggle={() => {}} now={NOW} />);
    for (const k of ["ENG-1", "Checkout fails", "In Progress"]) expect(html).toContain(k);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toMatch(/3 minutes ago|3분 전/);
  });

  it("a Jira link that is not http(s) is never rendered as a link in the skipped list", () => {
    const jira = { loading: false, links: [link()], connection: null, connected: true, needsReconnect: false, commentsToJira: true, hasOkLink: true, atLimit: false, sharedNoteIds: new Set<string>(), attachmentsEnabled: false, sentAttachmentIds: new Set<string>(), skippedFiles: [{ id: "s", filename: "x", status: "failed" as const, jiraUrl: "javascript:alert(1)" }], sendAttachment: ok as never, reload: async () => {}, syncNow: ok as never, unlink: ok as never, listTransitions: ok as never, transition: ok as never, commentInJira: ok as never, shareNote: ok as never } satisfies TicketJira;
    const html = render(locale, <TicketJiraSection ticketId="t1" jira={jira} />);
    expect(html).not.toContain("javascript:");
  });

  describe("attachments", () => {
    const att = (over: Partial<TicketAttachment> = {}): TicketAttachment => ({ id: "a1", ticket_id: "t1", account_id: "a", storage_path: "account-a/tickets/1-a.pdf", url: "https://s/a.pdf", filename: "report.pdf", mime_type: "application/pdf", size_bytes: 2048, created_at: "2026-09-20T10:00:00Z", ...over });
    const base = { uploading: [], canWork: true, canRemove: () => false, onAddFiles: () => {}, onRemove: () => {} };

    it("shows Send to Jira on a file, 'In Jira' once sent, and 'From Jira' on a file that came from Jira", () => {
      const html = render(
        locale,
        <TicketAttachmentsSection
          {...base}
          attachments={[att(), att({ id: "a2", filename: "sent.pdf" }), att({ id: "a3", filename: "theirs.pdf", source: "jira" }), att({ id: "a4", filename: "pic.png", mime_type: "image/png" })]}
          jira={{ canSend: true, sentIds: new Set(["a2"]), busyId: null, onSend: () => {} }}
        />,
      );
      expect(html).toContain(m().Jira.attachments.sendNamed.replace("{name}", "report.pdf"));
      expect(html).toContain(m().Jira.attachments.sendNamed.replace("{name}", "pic.png"));
      expect(html).toContain(m().Jira.attachments.sent);
      expect(html).toContain(m().Jira.attachments.fromJira);
      // a file that came from Jira and one already sent get no send button
      expect(html).not.toContain(m().Jira.attachments.sendNamed.replace("{name}", "theirs.pdf"));
      expect(html).not.toContain(m().Jira.attachments.sendNamed.replace("{name}", "sent.pdf"));
    });

    it("without the Jira props there is no Send button, but a file from Jira is still tagged", () => {
      const html = render(locale, <TicketAttachmentsSection {...base} attachments={[att(), att({ id: "a3", source: "jira", filename: "theirs.pdf" })]} />);
      expect(html).not.toContain(m().Jira.attachments.send);
      expect(html).toContain(m().Jira.attachments.fromJira);
    });

    it("viewers (cannot send) see the tags but no button", () => {
      const html = render(locale, <TicketAttachmentsSection {...base} attachments={[att(), att({ id: "a2", filename: "sent.pdf" })]} jira={{ canSend: false, sentIds: new Set(["a2"]), busyId: null, onSend: () => {} }} />);
      expect(html).toContain(m().Jira.attachments.sent);
      expect(html).not.toContain(m().Jira.attachments.sendNamed.replace("{name}", "report.pdf"));
    });
  });

  it("the create preview lists the custom fields the mappings fill and the component", () => {
    const props: JiraCreateFormProps = {
      siteUrl: "https://acme.atlassian.net",
      projects: [{ id: "1", key: "ENG", name: "Engineering" }],
      projectsLoading: false,
      issueTypes: [{ id: "10004", name: "Bug" }],
      issueTypesLoading: false,
      priorities: [{ id: "2", name: "High" }],
      choices: { ...EMPTY_CREATE_CHOICES, projectKey: "ENG", issueTypeId: "10004" },
      onChoicesChange: () => {},
      onSearchUsers: async () => [],
      preview: {
        preview: {
          project: "ENG",
          issueType: "Bug",
          summary: "Login fails",
          descriptionText: "Customer cannot sign in.",
          descriptionTruncated: false,
          priority: "High",
          labels: ["vircle"],
          assigneeAccountId: null,
          includesCustomer: false,
          extraFields: {},
          mappedFields: [
            { label: "Browser", jiraName: "Browser version", display: "Safari 17" },
            { label: "VIP", jiraName: "Labels", display: "yes" },
          ],
          component: "Checkout",
        },
        required: { ask: [], unsupported: [] },
        previewRequired: true,
      },
      previewLoading: false,
      previewError: null,
      fieldValues: {},
      onFieldValuesChange: () => {},
      creating: false,
      createError: null,
      onCreate: () => {},
      onCancel: () => {},
    };
    const html = render(locale, <JiraCreateForm {...props} />);
    expect(html).toContain(m().Jira.depth.preview.mappedHeading);
    for (const k of ["Browser", "Browser version", "Safari 17", "Checkout"]) expect(html).toContain(k);
    expect(html).toContain(m().Jira.depth.preview.component);
    // and nothing extra when there are none
    const plain = render(locale, <JiraCreateForm {...props} preview={{ ...props.preview!, preview: { ...props.preview!.preview, mappedFields: [], component: null } }} />);
    expect(plain).not.toContain(m().Jira.depth.preview.mappedHeading);
  });

  it("every new Jira string exists in both languages with the same argument names", () => {
    const en = load("en").Jira;
    const ko = load("ko").Jira;
    const args = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\s*[,}]/g)].map((x) => x[1]))].sort().join(",");
    const walk = (a: unknown, b: unknown, path: string) => {
      if (typeof a === "string") {
        expect(typeof b, path).toBe("string");
        expect(args(b as string), path).toBe(args(a));
        return;
      }
      expect(Object.keys(b as object).sort(), path).toEqual(Object.keys(a as object).sort());
      for (const k of Object.keys(a as object)) walk((a as never)[k], (b as never)[k], `${path}.${k}`);
    };
    for (const ns of ["bulk", "attachments", "depth"]) walk(en[ns], ko[ns], ns);
    for (const k of ["bulk_limit", "too_large", "issue_full", "mime_refused", "mime_mismatch", "active_content", "attachments_disabled", "already", "duplicate", "from_jira", "bad_path"]) {
      expect(en.errors[k], k).toBeTruthy();
      expect(ko.errors[k], k).toBeTruthy();
    }
  });
});
