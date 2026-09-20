// ============================================================
// Create an issue from a ticket: build exactly what will be sent, and decide
// which required fields the dialog can render. Pure, no I/O.
//
// The preview the agent sees is produced by the SAME function that builds the
// request, so "what you see is what is sent". Customer name and email are
// left out unless an admin turned that on (Settings > Integrations > Jira >
// Privacy).
// ============================================================

import { buildIssueDescription, textToAdf, type AdfDoc } from "./adf";
import { priorityNameFor } from "./settings";
import { JIRA_SUMMARY_MAX, type JiraSettings, type TicketPriorityValue } from "./types";
import type { CreateField } from "./client";

export interface TicketInput {
  ticket_number: number;
  subject: string;
  description: string | null;
  category: string;
  priority: TicketPriorityValue;
}

export interface CustomerInput {
  name: string | null;
  email: string | null;
  phone?: string | null;
}

/** Jira labels cannot contain spaces; keep them short and plain. */
export function sanitizeLabel(raw: string): string | null {
  const l = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 50);
  return l || null;
}

/** The summary: one line, cut at Jira's 255 characters with an ellipsis. */
export function buildSummary(subject: string): string {
  const one = subject.replace(/\s+/g, " ").trim() || "Untitled ticket";
  return one.length <= JIRA_SUMMARY_MAX ? one : `${one.slice(0, JIRA_SUMMARY_MAX - 1).trimEnd()}…`;
}

// ------------------------------------------------------------
// Which required fields can the dialog render?
// ------------------------------------------------------------

export type FieldKind = "text" | "textarea" | "select" | "multiselect" | "user" | "labels" | "number" | "date";

/** Fields the request always fills itself. */
const HANDLED = new Set(["project", "issuetype", "summary", "description", "reporter", "labels"]);

const TEXTAREA_CUSTOM = "com.atlassian.jira.plugin.system.customfieldtypes:textarea";

/** The control that can edit a create field, or null when it cannot be rendered ("Open in Jira instead"). */
export function fieldKind(f: CreateField): FieldKind | null {
  const s = f.schema ?? {};
  if (f.allowedValues && f.allowedValues.length > 0) {
    if (s.type === "array") return "multiselect";
    if (s.type === "option" || s.type === "priority" || s.type === "resolution" || s.type === "issuetype" || s.type === "string" || s.type === undefined) return "select";
    return null;
  }
  switch (s.type) {
    case "string":
      return s.custom === TEXTAREA_CUSTOM || s.system === "environment" ? "textarea" : "text";
    case "number":
      return "number";
    case "date":
      return "date";
    case "user":
      return "user";
    case "array":
      return s.items === "string" ? "labels" : s.items === "user" ? null : null;
    default:
      return null;
  }
}

export interface RequiredAnalysis {
  /** Required fields the dialog must ask for. */
  ask: { field: CreateField; kind: FieldKind }[];
  /** Required fields no control can edit: the dialog offers "Open in Jira instead". */
  unsupported: CreateField[];
}

/**
 * Required fields of the chosen type that the request does not already fill.
 * `filled` is the set of field ids the request will contain (priority when it
 * is mapped, labels, ...).
 */
export function analyseRequired(fields: readonly CreateField[], filled: ReadonlySet<string>): RequiredAnalysis {
  const ask: RequiredAnalysis["ask"] = [];
  const unsupported: CreateField[] = [];
  for (const f of fields) {
    if (!f.required || f.hasDefaultValue) continue;
    const id = f.key ?? f.fieldId;
    if (HANDLED.has(id) || filled.has(id)) continue;
    const kind = fieldKind(f);
    if (kind) ask.push({ field: f, kind });
    else unsupported.push(f);
  }
  return { ask, unsupported };
}

/** Turn what the dialog collected into the value Jira expects for that field. */
export function coerceFieldValue(f: CreateField, kind: FieldKind, raw: unknown): unknown {
  switch (kind) {
    case "text":
      return typeof raw === "string" ? raw.slice(0, 255) : "";
    case "textarea":
      return textToAdf(typeof raw === "string" ? raw : "");
    case "number": {
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case "date":
      return typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : undefined;
    case "user":
      return typeof raw === "string" && raw ? { accountId: raw } : undefined;
    case "labels":
      return (Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/) : [])
        .map((x) => (typeof x === "string" ? sanitizeLabel(x) : null))
        .filter((x): x is string => !!x)
        .slice(0, 10);
    case "select": {
      const id = typeof raw === "string" ? raw : "";
      return id && (f.allowedValues ?? []).some((v) => v.id === id) ? { id } : undefined;
    }
    case "multiselect": {
      const ids = (Array.isArray(raw) ? raw : []).filter((x): x is string => typeof x === "string");
      const allowed = new Set((f.allowedValues ?? []).map((v) => v.id));
      const picked = ids.filter((i) => allowed.has(i)).map((id) => ({ id }));
      return picked.length ? picked : undefined;
    }
  }
}

// ------------------------------------------------------------
// The request and its preview
// ------------------------------------------------------------

export interface CreateChoices {
  projectKey: string;
  issueTypeId: string;
  issueTypeName?: string;
  /** Overrides the mapped priority (a Jira priority name). */
  priorityName?: string | null;
  extraLabels?: string[];
  assigneeAccountId?: string | null;
  /** Values for the required fields the dialog asked for, by field id. */
  fieldValues?: Record<string, unknown>;
}

export interface CreatePlan {
  /** The `fields` object of POST /issue. */
  fields: Record<string, unknown>;
  preview: {
    project: string;
    issueType: string | null;
    summary: string;
    /** The description as it will read, in plain text. */
    descriptionText: string;
    descriptionTruncated: boolean;
    priority: string | null;
    labels: string[];
    assigneeAccountId: string | null;
    includesCustomer: boolean;
    /** Field id -> the value the agent chose. */
    extraFields: Record<string, unknown>;
    /** Custom fields the mappings fill from the ticket (Settings > Jira > Fields). */
    mappedFields: { label: string; jiraName: string; display: string }[];
    /** The category as a Jira component, when that mapping is on and the project has one of that name. */
    component: string | null;
  };
}

export function buildCreatePlan(args: {
  ticket: TicketInput;
  customer: CustomerInput | null;
  settings: JiraSettings;
  choices: CreateChoices;
  ticketKey: string;
  ticketUrl: string | null;
  /** Create-metadata of the chosen type, when known (drops fields the screen does not have). */
  createFields?: readonly CreateField[];
  descriptionToPlain?: (doc: AdfDoc) => string;
}): CreatePlan {
  const { ticket, settings, choices } = args;
  const has = (id: string) => !args.createFields || args.createFields.some((f) => (f.key ?? f.fieldId) === id);

  const includeCustomer = settings.privacy.include_customer && !!args.customer;
  const extra: string[] = [];
  if (includeCustomer && args.customer) {
    const who = [args.customer.name, args.customer.email ? `<${args.customer.email}>` : null].filter(Boolean).join(" ");
    if (who) extra.push(`Customer: ${who}`);
  }

  const desc = buildIssueDescription({
    text: ticket.description,
    ticketKey: args.ticketKey,
    ticketUrl: args.ticketUrl,
    extraLines: extra,
  });

  const labels = new Set<string>(["vircle"]);
  if (settings.mapping.category_label) {
    const c = sanitizeLabel(ticket.category);
    if (c) labels.add(c);
  }
  for (const l of choices.extraLabels ?? []) {
    const s = sanitizeLabel(l);
    if (s) labels.add(s);
  }

  const summary = buildSummary(ticket.subject);
  const priority = choices.priorityName ?? priorityNameFor(settings, ticket.priority);

  const fields: Record<string, unknown> = {
    project: { key: choices.projectKey },
    issuetype: { id: choices.issueTypeId },
    summary,
    description: desc.doc,
  };
  if (has("labels")) fields.labels = [...labels].slice(0, 10);
  if (priority && has("priority")) fields.priority = { name: priority };
  if (choices.assigneeAccountId && has("assignee")) fields.assignee = { accountId: choices.assigneeAccountId };
  for (const [id, v] of Object.entries(choices.fieldValues ?? {})) {
    if (v !== undefined && !(id in fields)) fields[id] = v;
  }

  const toPlain = args.descriptionToPlain ?? (() => "");
  return {
    fields,
    preview: {
      project: choices.projectKey,
      issueType: choices.issueTypeName ?? null,
      summary,
      descriptionText: toPlain(desc.doc),
      descriptionTruncated: desc.truncated,
      priority: priority && has("priority") ? priority : null,
      labels: (fields.labels as string[] | undefined) ?? [],
      assigneeAccountId: choices.assigneeAccountId ?? null,
      includesCustomer: includeCustomer,
      extraFields: choices.fieldValues ?? {},
      mappedFields: [],
      component: null,
    },
  };
}

/** The stable id of the "Vircle ticket" remote link: the same id updates instead of duplicating. */
export function remoteLinkGlobalId(accountId: string, ticketId: string): string {
  return `vircle:${accountId}:ticket:${ticketId}`.slice(0, 255);
}

/** Pull a key or numeric id out of what an agent pasted: a key, a /browse/ URL or a selected-issue URL. */
export function parseIssueRef(input: string): { key: string } | null {
  const s = input.trim();
  if (!s) return null;
  const KEY = /\b([A-Za-z][A-Za-z0-9_]{1,9}-\d{1,9})\b/;
  try {
    const u = new URL(s);
    if (u.protocol === "https:" || u.protocol === "http:") {
      const fromPath = /\/browse\/([A-Za-z][A-Za-z0-9_]{1,9}-\d{1,9})/i.exec(u.pathname);
      const fromQuery = u.searchParams.get("selectedIssue");
      const k = fromPath?.[1] ?? (fromQuery && KEY.exec(fromQuery)?.[1]);
      return k ? { key: k.toUpperCase() } : null;
    }
  } catch {
    // not a URL
  }
  const m = KEY.exec(s);
  return m && m[1].length === s.length ? { key: m[1].toUpperCase() } : null;
}
