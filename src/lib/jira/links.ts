// ============================================================
// Phase 1 operations on a ticket: create an issue from it, link an existing
// issue, unlink, move the issue to another status by hand. Each takes an
// injected store and client, so the rules (project allow-list, five links,
// required fields, what gets sent) are unit-tested without Jira.
//
// The ticket page never calls Jira to draw itself: it reads the cached
// `ticket_jira_links` row these functions write.
// ============================================================

import { adfToPlainText } from "./adf";
import {
  analyseRequired,
  buildCreatePlan,
  coerceFieldValue,
  parseIssueRef,
  remoteLinkGlobalId,
  type CreateChoices,
  type CreatePlan,
  type RequiredAnalysis,
} from "./create-issue";
import type { CreateField } from "./client";
import { describeError, JiraNotFoundError, JiraPermissionError, JiraValidationError } from "./errors";
import { effectiveSettings, normalizeCategory, transitionFields, type JiraTransition } from "./settings";
import { buildMappedCreateFields, type MappedCreate } from "./fields-sync";
import { cachePatch, issueFieldList, syncComments, ticketUrl, type SyncContext } from "./sync";
import {
  MAX_LINKS_PER_TICKET,
  type JiraIssue,
  type TicketJiraLinkRow,
  type TicketPriorityValue,
} from "./types";

/** A refusal with a stable code the routes map to a status and the UI to a sentence. */
export class LinkError extends Error {
  constructor(
    readonly code:
      | "not_found"
      | "no_connection"
      | "inactive"
      | "project_not_allowed"
      | "link_limit"
      | "already_linked"
      | "bad_reference"
      | "unsupported_fields"
      | "missing_fields"
      | "jira_rejected"
      | "no_permission"
      | "transition_unavailable"
      | "bulk_limit",
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "LinkError";
  }
}

function assertActive(ctx: SyncContext): void {
  if (ctx.connection.status !== "active") throw new LinkError("inactive", "The Jira connection needs to be reconnected");
}

function assertProjectAllowed(ctx: SyncContext, projectKey: string | null | undefined): void {
  const allowed = ctx.settings.projects.allowed;
  if (allowed.length > 0 && projectKey && !allowed.includes(projectKey.toUpperCase())) {
    throw new LinkError("project_not_allowed", `Tickets may not link to project ${projectKey}`, { project: projectKey });
  }
}

// ------------------------------------------------------------
// Link an existing issue
// ------------------------------------------------------------

export async function linkExistingIssue(
  ctx: SyncContext,
  args: { ticketId: string; reference: string; userId: string | null },
): Promise<TicketJiraLinkRow> {
  assertActive(ctx);
  const { store } = ctx;
  const ref = parseIssueRef(args.reference);
  if (!ref) throw new LinkError("bad_reference", "That is not a Jira issue key or link");

  const ticket = await store.getTicket(args.ticketId);
  if (!ticket || ticket.account_id !== ctx.connection.account_id) throw new LinkError("not_found", "Ticket not found");

  const existing = await store.linksForTicket(ticket.id);
  if (existing.length >= MAX_LINKS_PER_TICKET) {
    throw new LinkError("link_limit", `A ticket can link at most ${MAX_LINKS_PER_TICKET} Jira issues`);
  }

  let issue: JiraIssue | null;
  try {
    issue = await ctx.client.getIssue(ref.key, await issueFieldList(ctx));
  } catch (e) {
    if (e instanceof JiraNotFoundError) throw new LinkError("not_found", `Jira could not find ${ref.key}`, { key: ref.key });
    if (e instanceof JiraPermissionError) throw new LinkError("no_permission", `The connected user cannot see ${ref.key}`, { key: ref.key });
    throw e;
  }
  if (!issue) throw new LinkError("not_found", `Jira could not find ${ref.key}`);
  assertProjectAllowed(ctx, issue.fields.project?.key);
  // Keyed by the permanent id, not the key the agent typed (keys change when an issue moves).
  if (existing.some((l) => l.issue_id === issue!.id)) {
    throw new LinkError("already_linked", `${issue.key} is already linked to this ticket`);
  }

  const link = await insertLinkRow(ctx, ticket.id, issue, args.userId);
  await afterLinked(ctx, link, issue, ticket, { created: false, userId: args.userId, seedComments: true });
  return link;
}

/**
 * Link a ticket to an issue that was already read (the bulk "Link to Jira
 * issue" reads it once for the whole selection). Same rules as
 * linkExistingIssue: five links at most, the project must be allowed.
 */
export async function linkIssueToTicket(
  ctx: SyncContext,
  args: { ticketId: string; issue: JiraIssue; userId: string | null },
): Promise<TicketJiraLinkRow> {
  assertActive(ctx);
  const { store } = ctx;
  const ticket = await store.getTicket(args.ticketId);
  if (!ticket || ticket.account_id !== ctx.connection.account_id) throw new LinkError("not_found", "Ticket not found");
  assertProjectAllowed(ctx, args.issue.fields.project?.key);
  const existing = await store.linksForTicket(ticket.id);
  if (existing.length >= MAX_LINKS_PER_TICKET) {
    throw new LinkError("link_limit", `A ticket can link at most ${MAX_LINKS_PER_TICKET} Jira issues`);
  }
  if (existing.some((l) => l.issue_id === args.issue.id)) {
    throw new LinkError("already_linked", `${args.issue.key} is already linked to this ticket`);
  }
  const link = await insertLinkRow(ctx, ticket.id, args.issue, args.userId);
  await afterLinked(ctx, link, args.issue, ticket, { created: false, userId: args.userId, seedComments: true });
  return link;
}

async function insertLinkRow(
  ctx: SyncContext,
  ticketId: string,
  issue: JiraIssue,
  userId: string | null,
): Promise<TicketJiraLinkRow> {
  const at = new Date((ctx.now ?? Date.now)()).toISOString();
  try {
    return await ctx.store.insertLink({
      account_id: ctx.connection.account_id,
      ticket_id: ticketId,
      connection_id: ctx.connection.id,
      issue_id: issue.id,
      linked_by: userId,
      ...cachePatch(ctx, issue, at),
    });
  } catch (e) {
    const err = e as { code?: string; hint?: string };
    if (err.hint === "jira_link_limit") throw new LinkError("link_limit", `A ticket can link at most ${MAX_LINKS_PER_TICKET} Jira issues`);
    if (err.code === "23505") throw new LinkError("already_linked", `${issue.key} is already linked to this ticket`);
    throw e;
  }
}

async function afterLinked(
  ctx: SyncContext,
  link: TicketJiraLinkRow,
  issue: JiraIssue,
  ticket: NonNullable<Awaited<ReturnType<SyncContext["store"]["getTicket"]>>>,
  opts: { created: boolean; userId: string | null; seedComments: boolean },
): Promise<void> {
  const { store } = ctx;
  const key = await store.ticketKey(ticket);

  // The back link in Jira; the same globalId updates instead of duplicating. Best effort.
  const url = ticketUrl(ctx, ticket.id);
  if (url) {
    try {
      const res = await ctx.client.upsertRemoteLink(issue.id, {
        globalId: remoteLinkGlobalId(ticket.account_id, ticket.id),
        url,
        title: `Vircle ticket ${key}`,
        summary: ticket.subject.slice(0, 200),
        resolved: ["resolved", "closed"].includes(ticket.status),
      });
      if (res?.id != null) await store.updateLink(link.id, { remote_link_id: String(res.id) });
    } catch (e) {
      await store.logEvent({
        accountId: link.account_id,
        connectionId: ctx.connection.id,
        linkId: link.id,
        level: "warn",
        kind: "remote_link_failed",
        message: `${issue.key}: could not add the back link (${describeError(e)})`,
      });
    }
  }

  await store.addActivity({
    ticketId: ticket.id,
    accountId: ticket.account_id,
    eventType: "jira_linked",
    actorId: opts.userId,
    toValue: issue.key,
    detail: opts.created ? "created" : null,
  });
  await store.audit({
    accountId: ticket.account_id,
    actorId: opts.userId,
    action: "linked",
    entityType: "ticket_jira_link",
    entityId: link.id,
    label: issue.key,
    summary: { ticket: key, issue: issue.key, created: opts.created },
  });

  if (opts.seedComments) {
    // Existing Jira comments are recorded as seen, not imported: only new ones become notes.
    try {
      await syncComments(ctx, link, issue, ticket, true);
    } catch (e) {
      await store.logEvent({
        accountId: link.account_id,
        connectionId: ctx.connection.id,
        linkId: link.id,
        level: "warn",
        kind: "seed_comments_failed",
        message: describeError(e),
      });
    }
  }
}

// ------------------------------------------------------------
// Create an issue from a ticket
// ------------------------------------------------------------

export interface CreatePreviewResult {
  plan: CreatePlan;
  required: RequiredAnalysis;
}

export async function planFor(
  ctx: SyncContext,
  ticketId: string,
  choices: CreateChoices,
  customer: { name: string | null; email: string | null } | null,
): Promise<{ plan: CreatePlan; required: RequiredAnalysis; fields: CreateField[]; ticketKey: string; ticketAccount: string; mapped: MappedCreate }> {
  const { store } = ctx;
  const ticket = await store.getTicket(ticketId);
  if (!ticket || ticket.account_id !== ctx.connection.account_id) throw new LinkError("not_found", "Ticket not found");
  assertProjectAllowed(ctx, choices.projectKey);

  const meta = await ctx.client.listCreateFields(choices.projectKey, choices.issueTypeId);
  const fields = (meta?.fields ?? meta?.values ?? []) as CreateField[];
  const key = await store.ticketKey(ticket);

  // The most specific setting wins: this project's overrides over the workspace's.
  const eff = effectiveSettings(ctx.settings, choices.projectKey);
  const plan = buildCreatePlan({
    ticket: {
      ticket_number: ticket.ticket_number,
      subject: ticket.subject,
      description: ticket.description,
      category: ticket.category,
      priority: ticket.priority as TicketPriorityValue,
    },
    customer,
    settings: eff,
    choices,
    ticketKey: key,
    ticketUrl: ticketUrl(ctx, ticket.id),
    createFields: fields.length ? fields : undefined,
    descriptionToPlain: (doc) => adfToPlainText(doc),
  });

  // Category as a component: only when the project really has one of that name (Jira refuses unknown ones).
  const hasField = (id: string) => fields.length === 0 || fields.some((f) => (f.key ?? f.fieldId) === id);
  if (eff.mapping.category_component && ticket.category && hasField("components")) {
    try {
      const comps = (await ctx.client.listProjectComponents(choices.projectKey)) ?? [];
      const hit = comps.find((c) => c.name.trim().toLowerCase() === ticket.category.trim().toLowerCase());
      if (hit) {
        plan.fields.components = [{ id: hit.id }];
        plan.preview.component = hit.name;
      }
    } catch {
      // A component is a nicety: never block the issue on it.
    }
  }

  // Custom fields from the mappings (Settings > Jira > Fields).
  const at = new Date((ctx.now ?? Date.now)()).toISOString();
  const [mappings, defs] = await Promise.all([store.listFieldMappings(ctx.connection.id), store.getFieldDefinitions(ticket.account_id)]);
  const mapped = buildMappedCreateFields({
    mappings: mappings ?? [],
    projectKey: choices.projectKey,
    defs: defs ?? [],
    customValues: ticket.custom_fields,
    createFields: fields,
    at,
  });
  for (const [id, v] of Object.entries(mapped.fields)) if (!(id in plan.fields)) plan.fields[id] = v;
  if (mapped.extraLabels.length > 0) {
    const labels = new Set<string>((plan.fields.labels as string[] | undefined) ?? []);
    for (const l of mapped.extraLabels) labels.add(l);
    if (hasField("labels")) {
      plan.fields.labels = [...labels].slice(0, 10);
      plan.preview.labels = plan.fields.labels as string[];
    }
  }
  plan.preview.mappedFields = mapped.preview.map((p) => ({ label: p.label, jiraName: p.jiraName, display: p.display }));

  const filled = new Set(Object.keys(plan.fields));
  return { plan, required: analyseRequired(fields, filled), fields, ticketKey: key, ticketAccount: ticket.account_id, mapped };
}

/** What would be sent, and which required fields the dialog still has to ask for. */
export async function previewCreate(
  ctx: SyncContext,
  args: { ticketId: string; choices: CreateChoices; customer: { name: string | null; email: string | null } | null },
): Promise<CreatePreviewResult> {
  assertActive(ctx);
  const p = await planFor(ctx, args.ticketId, args.choices, args.customer);
  return { plan: p.plan, required: p.required };
}

export async function createIssueFromTicket(
  ctx: SyncContext,
  args: {
    ticketId: string;
    choices: CreateChoices;
    /** Raw values of the required fields the dialog asked for, by field id. */
    rawFieldValues?: Record<string, unknown>;
    customer: { name: string | null; email: string | null } | null;
    userId: string | null;
  },
): Promise<TicketJiraLinkRow> {
  assertActive(ctx);
  const { store } = ctx;

  const existing = await store.linksForTicket(args.ticketId);
  if (existing.length >= MAX_LINKS_PER_TICKET) {
    throw new LinkError("link_limit", `A ticket can link at most ${MAX_LINKS_PER_TICKET} Jira issues`);
  }

  // First pass finds which required fields exist; then their values are coerced and the plan rebuilt.
  const first = await planFor(ctx, args.ticketId, args.choices, args.customer);
  if (first.required.unsupported.length > 0) {
    throw new LinkError("unsupported_fields", "This project requires fields Vircle cannot fill", {
      fields: first.required.unsupported.map((f) => f.name),
    });
  }
  const values: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const { field, kind } of first.required.ask) {
    const id = field.key ?? field.fieldId;
    const v = coerceFieldValue(field, kind, args.rawFieldValues?.[id]);
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) missing.push(field.name);
    else values[id] = v;
  }
  if (missing.length > 0) throw new LinkError("missing_fields", "Some required fields are empty", { fields: missing });

  const { plan, ticketKey, mapped } = await planFor(ctx, args.ticketId, { ...args.choices, fieldValues: values }, args.customer);

  let created: { id: string; key: string } | null;
  try {
    created = await ctx.client.createIssue(plan.fields);
  } catch (e) {
    if (e instanceof JiraValidationError) {
      throw new LinkError("jira_rejected", e.message, { fieldErrors: e.fieldErrors, messages: e.messages });
    }
    if (e instanceof JiraPermissionError) throw new LinkError("no_permission", "The connected Jira user may not create issues here");
    throw e;
  }
  if (!created) throw new LinkError("jira_rejected", "Jira did not return the new issue");

  // Read it back for the cache; if that fails, fall back to what we know so the link is not lost.
  let issue: JiraIssue;
  try {
    issue = (await ctx.client.getIssue(created.id, await issueFieldList(ctx))) ?? fallbackIssue(created, plan);
  } catch {
    issue = fallbackIssue(created, plan);
  }

  const ticket = (await store.getTicket(args.ticketId))!;
  let link: TicketJiraLinkRow;
  try {
    link = await insertLinkRow(ctx, ticket.id, issue, args.userId);
  } catch (e) {
    // The issue exists in Jira but the link could not be saved: say so, so it can be linked by key.
    await store.logEvent({
      accountId: ticket.account_id,
      connectionId: ctx.connection.id,
      level: "error",
      kind: "create_link_failed",
      message: `${created.key} was created but could not be linked to ${ticketKey}`,
    });
    throw e;
  }
  // What the mappings wrote at creation is the echo memory: the webhook that announces it is recognised.
  if (Object.keys(mapped.state).length > 0) {
    await store.setFieldState(link.id, mapped.state).catch(() => undefined);
    link.field_state = mapped.state;
  }
  await afterLinked(ctx, link, issue, ticket, { created: true, userId: args.userId, seedComments: false });
  return link;
}

function fallbackIssue(created: { id: string; key: string }, plan: CreatePlan): JiraIssue {
  return {
    id: created.id,
    key: created.key,
    fields: {
      summary: plan.preview.summary,
      project: { key: plan.preview.project },
      issuetype: plan.preview.issueType ? { name: plan.preview.issueType } : null,
      updated: new Date().toISOString(),
    },
  };
}

// ------------------------------------------------------------
// Unlink and manual transitions
// ------------------------------------------------------------

export async function unlinkIssue(ctx: SyncContext, args: { linkId: string; userId: string | null }): Promise<void> {
  const { store } = ctx;
  const link = await store.getLink(args.linkId);
  if (!link || link.account_id !== ctx.connection.account_id) throw new LinkError("not_found", "Link not found");
  const ticket = await store.getTicket(link.ticket_id);
  const key = ticket ? await store.ticketKey(ticket) : "";
  // Nothing is deleted in Jira; the back link there simply stops being updated.
  await store.deleteLink(link.id);
  await store.addActivity({
    ticketId: link.ticket_id,
    accountId: link.account_id,
    eventType: "jira_unlinked",
    actorId: args.userId,
    toValue: link.issue_key,
  });
  await store.audit({
    accountId: link.account_id,
    actorId: args.userId,
    action: "unlinked",
    entityType: "ticket_jira_link",
    entityId: link.id,
    label: link.issue_key,
    summary: { ticket: key, issue: link.issue_key },
  });
}

export interface AvailableTransition {
  id: string;
  name: string;
  to: string;
  category: string | null;
  /** The transition asks for fields Vircle cannot fill. */
  blocked: boolean;
}

/** The transitions the issue offers right now (nothing else is ever listed). */
export async function listTransitions(ctx: SyncContext, linkId: string): Promise<AvailableTransition[]> {
  assertActive(ctx);
  const link = await ctx.store.getLink(linkId);
  if (!link || link.account_id !== ctx.connection.account_id) throw new LinkError("not_found", "Link not found");
  const res = await ctx.client.getTransitions(link.issue_id);
  return (res?.transitions ?? [])
    .filter((t) => t.isAvailable !== false)
    .map((t) => ({
      id: t.id,
      name: t.name ?? t.to?.name ?? t.id,
      to: t.to?.name ?? t.name ?? t.id,
      category: t.to?.statusCategory?.key ?? null,
      blocked: !transitionFields(t as JiraTransition, ctx.settings.resolution).ok,
    }));
}

/** An agent moved the Jira issue by hand ("Move Jira issue to..."). */
export async function transitionByHand(
  ctx: SyncContext,
  args: { linkId: string; transitionId: string; userId: string | null },
): Promise<void> {
  assertActive(ctx);
  const { store } = ctx;
  const link = await store.getLink(args.linkId);
  if (!link || link.account_id !== ctx.connection.account_id) throw new LinkError("not_found", "Link not found");

  const res = await ctx.client.getTransitions(link.issue_id);
  const t = (res?.transitions ?? []).find((x) => x.id === args.transitionId && x.isAvailable !== false);
  if (!t) throw new LinkError("transition_unavailable", "That transition is not available for this issue any more");
  const fields = transitionFields(t as JiraTransition, ctx.settings.resolution);
  if (!fields.ok) throw new LinkError("unsupported_fields", "This transition asks for fields Vircle cannot fill", { fields: fields.missing });

  try {
    await ctx.client.doTransition(link.issue_id, t.id, fields.fields);
  } catch (e) {
    if (e instanceof JiraPermissionError) throw new LinkError("no_permission", "Jira says you cannot transition this issue");
    if (e instanceof JiraValidationError) throw new LinkError("jira_rejected", e.message, { fieldErrors: e.fieldErrors });
    throw e;
  }
  const at = new Date((ctx.now ?? Date.now)()).toISOString();
  const cat = normalizeCategory(t.to?.statusCategory?.key);
  // Remember what we wrote (guard 3) and show it on the card straight away.
  await store.updateLink(link.id, {
    status_id: t.to?.id ?? link.status_id,
    status_name: t.to?.name ?? link.status_name,
    status_category: cat ?? link.status_category,
    last_written: { status_category: cat ?? undefined, status_name: t.to?.name, at },
    last_push: null,
  });
  await store.addActivity({
    ticketId: link.ticket_id,
    accountId: link.account_id,
    eventType: "jira_status_pushed",
    actorId: args.userId,
    toValue: t.to?.name ?? null,
    detail: link.issue_key,
  });
}
