// ============================================================
// Custom fields between a ticket and its Jira issue (0.45.0): the I/O half of
// field-mapping.ts, with the echo guards.
//
//   create        buildMappedCreateFields: what the create request gets from
//                 the mappings (and what the dialog preview shows)
//   Vircle->Jira  pushFieldChanges: after a ticket edit, PUT /issue with ONLY
//                 the fields whose value changed since the last push
//   Jira->Vircle  pullFieldsIntoTicket: the sync worker reads the mapped
//                 fields with the issue; a value Jira changed is applied to the
//                 ticket (as "from Jira": nothing is queued back)
//
// Echo: per link and mapping the link remembers a hash of the value last
// pushed/applied and of the value last seen in Jira (`field_state`). A push of
// an unchanged value is skipped; a Jira value equal to what we wrote (or to
// what the ticket already has) is our own echo; a first sight is recorded, not
// imported.
// ============================================================

import type { CreateField, JiraClient } from "./client";
import { describeError, JiraNotFoundError, JiraPermissionError, JiraValidationError } from "./errors";
import { decidePull, decidePush, hashNorm } from "./field-echo";
import {
  classifyJiraField,
  fromJiraValue,
  mappingsForProject,
  mergeWrites,
  normalizeVircleValue,
  normToTicketValue,
  readFieldIds,
  toJiraWrite,
  type FieldMappingRow,
  type FieldWrite,
  type JiraFieldInfo,
  type Norm,
  type VircleFieldDef,
} from "./field-mapping";
import type { JiraStore, TicketRow } from "./store";
import type { FieldState, JiraConnectionRow, JiraIssue, TicketJiraLinkRow } from "./types";

export type FieldsClient = Pick<JiraClient, "updateIssue" | "getEditMeta">;

export interface FieldsContext {
  store: JiraStore;
  client: FieldsClient;
  connection: JiraConnectionRow;
  now?: () => number;
}

const iso = (ctx: Pick<FieldsContext, "now">) => new Date((ctx.now ?? Date.now)()).toISOString();

// ------------------------------------------------------------
// What the sync has to ask Jira for
// ------------------------------------------------------------

/** The Jira field ids that mappings reading from Jira need (added to the issue read). */
export function mappedReadFields(mappings: readonly FieldMappingRow[]): string[] {
  return readFieldIds(mappings);
}

// ------------------------------------------------------------
// Create
// ------------------------------------------------------------

export interface MappedCreate {
  /** Fields for POST /issue (labels are merged by the caller through `extraLabels`). */
  fields: Record<string, unknown>;
  extraLabels: string[];
  /** Jira field ids the mappings fill (they count as filled for the required-field analysis). */
  filled: string[];
  preview: { mappingId: string; label: string; jiraName: string; jiraFieldId: string; display: string }[];
  /** The echo memory to store on the new link. */
  state: Record<string, FieldState>;
  skipped: { mappingId: string; reason: string }[];
}

function display(v: Norm): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "yes" : "";
  return String(v).slice(0, 200);
}

/**
 * The mapped fields for a new issue: every mapping of the project that writes
 * to Jira ("to Jira" or "both"), converted, and dropped when the create screen
 * does not have the field. `createFields` is the create metadata of the chosen
 * project and issue type.
 */
export function buildMappedCreateFields(args: {
  mappings: readonly FieldMappingRow[];
  projectKey: string;
  defs: readonly VircleFieldDef[];
  customValues: Record<string, unknown> | null | undefined;
  createFields: readonly CreateField[];
  at: string;
}): MappedCreate {
  const out: MappedCreate = { fields: {}, extraLabels: [], filled: [], preview: [], state: {}, skipped: [] };
  const byId = new Map(args.createFields.map((f) => [f.key ?? f.fieldId, f]));
  for (const m of mappingsForProject(args.mappings, args.projectKey)) {
    if (m.direction === "from_jira") continue;
    const def = args.defs.find((d) => d.id === m.ticket_field_id && d.is_active !== false);
    const meta = byId.get(m.jira_field_id);
    if (!def) {
      out.skipped.push({ mappingId: m.id, reason: "no_field" });
      continue;
    }
    if (!meta) {
      out.skipped.push({ mappingId: m.id, reason: "not_on_screen" });
      continue;
    }
    const info = classifyJiraField(meta);
    const raw = args.customValues?.[def.id];
    const res = toJiraWrite({ def, info, mapping: m, raw });
    if (res.kind === "skip") {
      out.skipped.push({ mappingId: m.id, reason: res.reason });
      continue;
    }
    // On create a "remove label" or an empty value has nothing to say.
    if (res.write.update) {
      const ops = Object.values(res.write.update).flat() as { add?: string; remove?: string }[];
      for (const op of ops) if (op.add) out.extraLabels.push(op.add);
      if (!ops.some((op) => op.add)) continue;
    } else if (res.write.fields) {
      const v = res.write.fields[info.id];
      if (v === null || (Array.isArray(v) && v.length === 0)) continue;
      Object.assign(out.fields, res.write.fields);
    }
    out.filled.push(info.id);
    out.preview.push({ mappingId: m.id, label: def.label, jiraName: info.name, jiraFieldId: info.id, display: display(res.lands) });
    out.state[m.id] = { vircle: hashNorm(normalizeVircleValue(def, raw)), jira: hashNorm(res.lands), at: args.at };
  }
  return out;
}

// ------------------------------------------------------------
// Vircle -> Jira: after a ticket edit
// ------------------------------------------------------------

export interface PushFieldsResult {
  links: { linkId: string; key: string; pushed: string[]; skipped: number; error?: string }[];
}

/** The fields a ticket edit changed, pushed as ONE PUT per linked issue. */
export async function pushFieldChanges(ctx: FieldsContext, args: { ticketId: string }): Promise<PushFieldsResult> {
  const { store } = ctx;
  const out: PushFieldsResult = { links: [] };
  if (ctx.connection.status !== "active") return out;
  const ticket = await store.getTicket(args.ticketId);
  if (!ticket || ticket.account_id !== ctx.connection.account_id) return out;

  const all = (await store.listFieldMappings(ctx.connection.id)).filter((m) => m.direction !== "from_jira");
  if (all.length === 0) return out;
  const defs = await store.getFieldDefinitions(ticket.account_id);
  const links = (await store.linksForTicket(ticket.id)).filter((l) => l.sync_state === "ok");

  for (const link of links) {
    const mappings = mappingsForProject(all, link.project_key).filter((m) => m.direction !== "from_jira");
    if (mappings.length === 0) continue;

    // Decide first, so an edit that changed nothing mapped costs no Jira call at all.
    const candidates = mappings
      .map((m) => ({ m, def: defs.find((d) => d.id === m.ticket_field_id && d.is_active !== false) }))
      .filter((c): c is { m: FieldMappingRow; def: VircleFieldDef } => !!c.def)
      .filter(({ m, def }) => decidePush(link.field_state?.[m.id], normalizeVircleValue(def, ticket.custom_fields?.[def.id])) === "push");
    if (candidates.length === 0) continue;

    const res = { linkId: link.id, key: link.issue_key, pushed: [] as string[], skipped: 0 } as PushFieldsResult["links"][number];
    try {
      const meta = await ctx.client.getEditMeta(link.issue_id);
      const editable = new Map<string, JiraFieldInfo>();
      for (const [id, f] of Object.entries(meta?.fields ?? {})) editable.set(id, classifyJiraField({ ...f, fieldId: id, key: id } as CreateField));

      const writes: FieldWrite[] = [];
      const next: Record<string, FieldState> = { ...(link.field_state ?? {}) };
      const at = iso(ctx);
      for (const { m, def } of candidates) {
        const info = editable.get(m.jira_field_id);
        if (!info) {
          res.skipped += 1;
          continue;
        }
        const raw = ticket.custom_fields?.[def.id];
        const w = toJiraWrite({ def, info, mapping: m, raw });
        if (w.kind === "skip") {
          res.skipped += 1;
          continue;
        }
        writes.push(w.write);
        res.pushed.push(m.jira_field_id);
        next[m.id] = { vircle: hashNorm(normalizeVircleValue(def, raw)), jira: hashNorm(w.lands), at };
      }
      if (writes.length > 0) {
        await ctx.client.updateIssue(link.issue_id, mergeWrites(writes));
        await store.setFieldState(link.id, next);
        await store.logEvent({
          accountId: link.account_id,
          connectionId: ctx.connection.id,
          linkId: link.id,
          level: "info",
          kind: "fields_pushed",
          message: `${link.issue_key}: ${res.pushed.length} field${res.pushed.length === 1 ? "" : "s"} updated`,
        });
      }
    } catch (e) {
      // Retryable (rate limit, outage): the queue backs off, and the unchanged hashes make a retry idempotent.
      if ((e as { retryable?: boolean })?.retryable) throw e;
      res.error = e instanceof JiraPermissionError ? "permission" : e instanceof JiraNotFoundError ? "not_found" : e instanceof JiraValidationError ? "rejected" : "error";
      await store.logEvent({
        accountId: link.account_id,
        connectionId: ctx.connection.id,
        linkId: link.id,
        level: "warn",
        kind: "fields_push_failed",
        message: `${link.issue_key}: ${describeError(e)}`,
        details: e instanceof JiraValidationError ? { fieldErrors: e.fieldErrors } : null,
      });
    }
    out.links.push(res);
  }
  return out;
}

// ------------------------------------------------------------
// Jira -> Vircle: in the sync worker
// ------------------------------------------------------------

export interface PullFieldsResult {
  applied: string[];
  seeded: number;
  echoes: number;
}

/**
 * Apply the mapped fields of an issue read to the ticket. Runs inside
 * applyIssueToLink; `issue.fields` already holds the mapped ids (the sync asks
 * for them). Returns what changed.
 */
export async function pullFieldsIntoTicket(
  ctx: FieldsContext,
  link: TicketJiraLinkRow,
  issue: JiraIssue,
  ticket: TicketRow,
  mappings: readonly FieldMappingRow[],
): Promise<PullFieldsResult> {
  const { store } = ctx;
  const out: PullFieldsResult = { applied: [], seeded: 0, echoes: 0 };
  const mine = mappingsForProject(mappings, issue.fields.project?.key ?? link.project_key).filter((m) => m.direction !== "to_jira");
  if (mine.length === 0) return out;

  const defs = await store.getFieldDefinitions(link.account_id);
  const state: Record<string, FieldState> = { ...(link.field_state ?? {}) };
  const set: Record<string, unknown> = {};
  const at = iso(ctx);
  let dirty = false;

  for (const m of mine) {
    const def = defs.find((d) => d.id === m.ticket_field_id && d.is_active !== false);
    if (!def) continue;
    // The field was not on the read at all (not asked for, or the screen lost it): nothing to compare.
    if (!(m.jira_field_id in issue.fields)) continue;

    const info: JiraFieldInfo = { id: m.jira_field_id, name: m.jira_field_name, kind: m.jira_kind, required: false, options: [], supported: true };
    const got = fromJiraValue({ def, info, raw: issue.fields[m.jira_field_id], mapping: m });
    if (got.kind === "skip") continue;

    let norm: Norm = got.norm;
    const jiraHash = hashNorm(norm);
    const ticketNorm = normalizeVircleValue(def, ticket.custom_fields?.[def.id]);
    const decision = decidePull(state[m.id], norm);

    if (decision.kind === "seed") {
      state[m.id] = { vircle: hashNorm(ticketNorm), jira: jiraHash, at };
      out.seeded += 1;
      dirty = true;
      continue;
    }
    if (decision.kind === "unchanged") continue;
    if (decision.kind === "echo") {
      state[m.id] = { ...state[m.id], jira: jiraHash, at };
      out.echoes += 1;
      dirty = true;
      continue;
    }

    // Jira changed it. A missing value follows the mapping's "when the value is missing" choice.
    if (norm === null) {
      if (m.when_missing === "skip") {
        state[m.id] = { ...state[m.id], jira: jiraHash, at };
        dirty = true;
        continue;
      }
      if (m.when_missing === "default") {
        norm = normalizeVircleValue(def, m.default_value === null ? null : def.field_type === "checkbox" ? /^(true|1|yes|on)$/i.test(m.default_value) : m.default_value);
        if (norm === null) {
          state[m.id] = { ...state[m.id], jira: jiraHash, at };
          dirty = true;
          continue;
        }
      }
    }
    const value = normToTicketValue(def, norm);
    if (hashNorm(norm) !== hashNorm(ticketNorm)) set[def.id] = value === undefined ? null : value;
    out.applied.push(m.jira_field_id);
    state[m.id] = { vircle: hashNorm(norm), jira: jiraHash, at };
    dirty = true;
  }

  if (Object.keys(set).length > 0) await store.applyTicketFields(ticket.id, set);
  if (dirty) await store.setFieldState(link.id, state);
  return out;
}
