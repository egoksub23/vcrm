// ============================================================
// Bulk send (migration 162): one template, a list of people, one document each, sent in the background.
//
//   previewBulk   what would happen, with every problem found before anything is made (no side effects)
//   createBulk    checks the same things again, then records the batch (the job and its rows, in one transaction)
//   runBulk       the step of the one Doc Sign job (jobs.ts): claim a fair batch of waiting rows under a lease, and
//                 send one document for each through the same services a single send uses (createDraftFromTemplate,
//                 updateDraft, setSigners, sendDocument), so the monthly limit, the audit trail, the webhooks and the
//                 notifications all apply. A row that already has a document is never made twice, and a document
//                 that is already out is recorded as sent, never sent again.
//   cancelBulk, getBulkJob, listBulkJobs, bulkResultRows   what the screens read and do
//
// Everything runs with the service-role client, so each read and write is scoped to the workspace explicitly.
// ============================================================

import { forEachWithinBudget } from "@/lib/cron/guard";
import { UsageLimitError, assertCanSendDocument, signSendHeadroom } from "@/lib/platform/usage";

import { mergeKeysOf } from "../client/layout";
import { resolveDefaults } from "../defaults";
import { signEnabled } from "../feature";
import { checkRows, isPersonKey, parseBulkCsv, rawRowFromContact, rowIsClean, type ParsedBulkFile, type RawBulkRow } from "../bulk/parse";
import { buildSigners, expiryIso, keysNeedingColumns, parseOptions, planProblems, roleInfos, titleFor } from "../bulk/plan";
import { encodeProblem, problemText, type ResultRow } from "../bulk/results";
import {
  BULK_MAX_ROWS,
  type BulkHeadroom,
  type BulkJobStatus,
  type BulkJobView,
  type BulkOptions,
  type BulkPreview,
  type BulkPreviewRow,
  type BulkProblem,
  type BulkRowInput,
  type BulkRowState,
  type BulkRowView,
} from "../bulk/types";
import type { SignTemplateVersionRow } from "../types";
import { loadDocument, loadSettings, type SignCtx } from "./context";
import { applyCopyList } from "./copy-recipients";
import { createDraftFromTemplate, deleteDraft, setSigners, updateDraft, type DraftPatch } from "./drafts";
import { SignError, raiseDatabaseError } from "./errors";
import { sendDocument } from "./send";

type Base = Omit<SignCtx, "accountId" | "userId">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Ids in one `in (...)` filter: a long list would make the address too long for the database's front door. */
const IN_CHUNK = 100;

export interface BulkJobRow {
  id: string;
  account_id: string;
  template_id: string | null;
  template_name: string;
  created_by: string | null;
  status: BulkJobStatus;
  source: "csv" | "contacts";
  file_name: string | null;
  total_rows: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  options: BulkOptions;
  error_code: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface BulkRowRow {
  id: string;
  account_id: string;
  job_id: string;
  row_no: number;
  input: BulkRowInput;
  state: BulkRowState;
  document_id: string | null;
  error_code: string | null;
  error_message: string | null;
  claimed_until: string | null;
  attempts: number;
  processed_at: string | null;
}

async function inChunks<T>(ids: readonly string[], read: (chunk: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(...(await read(ids.slice(i, i + IN_CHUNK))));
  return out;
}

// ---- the template -----------------------------------------------------------------------------

async function loadTemplateFacts(ctx: SignCtx, templateId: string) {
  const t = await ctx.admin.from("sign_templates").select("*").eq("id", templateId).eq("account_id", ctx.accountId).maybeSingle();
  if (t.error) raiseDatabaseError(t.error, "load template");
  const template = t.data as { id: string; name: string; status: string; category_id: string | null; current_version_id: string | null } | null;
  if (!template) throw new SignError("template_not_found", "That template was not found.", 404);
  if (template.status !== "active") throw new SignError("template_not_active", "This template is not active.", 409);
  if (!template.current_version_id) throw new SignError("template_has_no_version", "This template has no saved version yet.", 409);
  const v = await ctx.admin.from("sign_template_versions").select("*").eq("id", template.current_version_id).eq("account_id", ctx.accountId).maybeSingle();
  if (v.error || !v.data) raiseDatabaseError(v.error, "load template version");
  return { template, version: v.data as SignTemplateVersionRow };
}

// ---- reading the list ---------------------------------------------------------------------------

interface ContactRow {
  id: string;
  name: string | null;
  email: string | null;
  phone: string | null;
}

async function loadContacts(ctx: SignCtx, ids: readonly string[]): Promise<Map<string, ContactRow>> {
  const rows = await inChunks<ContactRow>(ids, async (chunk) => {
    const { data, error } = await ctx.admin.from("contacts").select("id, name, email, phone").eq("account_id", ctx.accountId).is("deleted_at", null).in("id", chunk);
    if (error) raiseDatabaseError(error, "load contacts");
    return (data ?? []) as ContactRow[];
  });
  return new Map(rows.map((c) => [c.id, c]));
}

interface Evaluation {
  options: BulkOptions;
  template: { id: string; name: string };
  source: "csv" | "contacts";
  mergeKeys: string[];
  roles: ReturnType<typeof roleInfos>;
  file: ParsedBulkFile["problems"];
  ignoredColumns: string[];
  planProblems: BulkProblem[];
  rows: BulkPreviewRow[];
  headroom: BulkHeadroom;
}

/** Everything the preview shows and the creation decides on, worked out the same way for both. */
async function evaluate(ctx: SignCtx, body: Record<string, unknown>): Promise<Evaluation> {
  const parsed = parseOptions(body.options);
  if (!parsed.options) throw new SignError("bad_options", "The options for this batch are not valid.", 400, parsed.problems);
  const options = parsed.options;
  const { template, version } = await loadTemplateFacts(ctx, options.templateId);
  const mergeKeys = mergeKeysOf(version.fields).map((k) => k.key);

  // what the documents will use for signing order decides whether the same person on two roles is a problem
  let category: { expiry_days: number | null; reminder_days: number[] | null; code_required: boolean; sign_in_order: boolean } | null = null;
  const categoryId = options.categoryId ?? template.category_id;
  if (categoryId) {
    const c = await ctx.admin.from("sign_categories").select("*").eq("id", categoryId).eq("account_id", ctx.accountId).eq("archived", false).maybeSingle();
    if (c.error) raiseDatabaseError(c.error, "load category");
    if (!c.data) throw new SignError("category_not_found", "That category was not found.", 400);
    category = c.data as typeof category;
  }
  const defaults = resolveDefaults({ template: version.defaults, category, workspace: await loadSettings(ctx) });
  const signInOrder = options.signInOrder ?? defaults.signInOrder;

  if (body.csv !== undefined && body.contactIds !== undefined) throw new SignError("list_required", "Choose a file or some contacts, not both.", 400);
  let source: "csv" | "contacts";
  let fileProblems: BulkProblem[] = [];
  let ignoredColumns: string[] = [];
  let raw: RawBulkRow[];
  let contacts = new Map<string, ContactRow>();
  // the values the file must carry: in a contacts list only the person's own (name, email, phone) can be filled in
  let checkKeys = mergeKeys;

  if (typeof body.csv === "string") {
    source = "csv";
    const file = parseBulkCsv(body.csv, mergeKeys);
    raw = file.rows;
    fileProblems = file.problems;
    ignoredColumns = file.ignoredColumns;
    const ids = [...new Set(raw.map((r) => r.cells.contact_id).filter((v): v is string => !!v && UUID_RE.test(v)))];
    if (ids.length > 0) contacts = await loadContacts(ctx, ids);
  } else if (Array.isArray(body.contactIds)) {
    source = "contacts";
    const ids = [...new Set(body.contactIds.filter((v): v is string => typeof v === "string" && UUID_RE.test(v)))];
    if (ids.length === 0) fileProblems.push({ code: "no_rows" });
    if (ids.length > BULK_MAX_ROWS) fileProblems.push({ code: "too_many_rows", detail: String(ids.length) });
    const wanted = ids.slice(0, BULK_MAX_ROWS);
    contacts = await loadContacts(ctx, wanted);
    raw = wanted.map((id, i) => rawRowFromContact(i + 1, contacts.get(id) ?? { id, name: null, email: null, phone: null }));
    checkKeys = mergeKeys.filter(isPersonKey);
  } else {
    throw new SignError("list_required", "Choose a file or some contacts.", 400);
  }

  const rows = checkRows(raw, {
    mergeKeys: checkKeys,
    channel: options.channel,
    fixedEmails: options.fixedSigners.map((f) => f.email),
    signInOrder,
  });
  for (const r of rows) if (r.contactId && !contacts.has(r.contactId)) r.problems.push({ code: "contact_not_found" });

  const plan = planProblems({ roles: version.roles, fields: version.fields, form: version.form ?? null, pageCount: version.page_count, options, signInOrder, mode: version.mode });
  if (source === "contacts") {
    const needing = keysNeedingColumns(mergeKeys);
    if (needing.length > 0) plan.push({ code: "merge_needs_file", detail: needing.join(", ") });
  }

  const needed = rows.filter(rowIsClean).length;
  const room = await signSendHeadroom(ctx.admin, ctx.accountId);
  const headroom: BulkHeadroom = { limit: room.limit, used: room.used, remaining: room.remaining, needed, fits: room.remaining === null || needed <= room.remaining };

  return { options, template: { id: template.id, name: version.defaults.subject?.trim() || template.name }, source, mergeKeys, roles: roleInfos(version.roles, version.fields), file: fileProblems, ignoredColumns, planProblems: plan, rows, headroom };
}

/** What would happen if this batch were sent: every problem, row by row, and whether the month's limit has room. Changes nothing. */
export async function previewBulk(ctx: SignCtx, body: Record<string, unknown>): Promise<BulkPreview> {
  const e = await evaluate(ctx, body);
  const ok = e.rows.filter(rowIsClean).length;
  return {
    template: { id: e.template.id, name: e.template.name, mergeKeys: e.mergeKeys, roles: e.roles },
    file: { problems: e.file, ignoredColumns: e.ignoredColumns, rowCount: e.rows.length },
    plan: { problems: e.planProblems },
    rows: e.rows,
    counts: { total: e.rows.length, ok, withProblems: e.rows.length - ok },
    headroom: e.headroom,
  };
}

// ---- creating the batch --------------------------------------------------------------------------

/**
 * Record the batch. Refused (before anything is stored) when the file or the setup has problems, when no one can be
 * sent to, when the month's limit cannot take them all, and, unless `skipInvalid` is true, when any person has a
 * problem. With `skipInvalid` the people with a problem are recorded as skipped (with the reason) and the rest go out.
 */
export async function createBulk(ctx: SignCtx, body: Record<string, unknown>): Promise<BulkJobView> {
  const e = await evaluate(ctx, body);
  if (e.file.length > 0) throw new SignError("bulk_file_problems", "The list could not be used.", 400, e.file);
  if (e.planProblems.length > 0) throw new SignError("bulk_not_ready", "This batch is not set up correctly.", 400, e.planProblems);
  const clean = e.rows.filter(rowIsClean);
  const skipInvalid = body.skipInvalid === true;
  if (clean.length < e.rows.length && !skipInvalid) throw new SignError("rows_have_problems", "Some people on the list have problems.", 409, [{ code: "rows_have_problems", detail: String(e.rows.length - clean.length) }]);
  if (clean.length === 0) throw new SignError("nothing_to_send", "There is no one to send a document to.", 400);
  if (!e.headroom.fits) {
    throw new SignError("sign_limit_reached", "This batch is larger than the documents this workspace can still send this month.", 429, [{ code: "sign_limit_reached", detail: `${e.headroom.remaining ?? 0}/${clean.length}` }]);
  }

  const rows = e.rows.map((r) => {
    const input: BulkRowInput = { name: r.name, email: r.email, phone: r.phone, contactId: r.contactId, merge: r.merge };
    if (rowIsClean(r)) return { row_no: r.rowNo, input };
    const first = r.problems[0];
    return { row_no: r.rowNo, input, state: "skipped", error_code: encodeProblem(first), error_message: problemText(first.code, first.detail) };
  });
  const fileName = typeof body.fileName === "string" ? body.fileName.slice(0, 200) : null;
  const { data, error } = await ctx.admin.rpc("sign_bulk_create", {
    p_account: ctx.accountId,
    p_template: e.template.id,
    p_template_name: e.template.name,
    p_user: ctx.userId,
    p_source: e.source,
    p_file_name: e.source === "csv" ? fileName : null,
    p_options: e.options,
    p_rows: rows,
  });
  if (error || !data) {
    if (/too_many_bulk_jobs/.test(error?.message ?? "")) throw new SignError("too_many_bulk_jobs", "Three batches are already running. Wait for one to finish, then try again.", 429);
    raiseDatabaseError(error, "create bulk job");
  }
  return (await getBulkJob(ctx, data as string, { offset: 0, limit: 0 })).job;
}

// ---- what the screens read -----------------------------------------------------------------------

function viewOf(job: BulkJobRow, tally?: Record<BulkRowState, number>): BulkJobView {
  const sent = tally?.sent ?? job.sent_count;
  const failed = tally?.failed ?? job.failed_count;
  const skipped = tally?.skipped ?? job.skipped_count;
  return {
    id: job.id,
    templateId: job.template_id,
    templateName: job.template_name,
    status: job.status,
    source: job.source,
    fileName: job.file_name,
    total: job.total_rows,
    sent,
    failed,
    skipped,
    pending: tally ? tally.pending : Math.max(0, job.total_rows - sent - failed - skipped),
    errorCode: job.error_code,
    createdAt: job.created_at,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
  };
}

async function loadJob(ctx: SignCtx, jobId: string): Promise<BulkJobRow> {
  if (!UUID_RE.test(jobId)) throw new SignError("job_not_found", "That batch was not found.", 404);
  const { data, error } = await ctx.admin.from("sign_bulk_jobs").select("*").eq("id", jobId).eq("account_id", ctx.accountId).maybeSingle();
  if (error) raiseDatabaseError(error, "load bulk job");
  if (!data) throw new SignError("job_not_found", "That batch was not found.", 404);
  return data as BulkJobRow;
}

async function referencesFor(ctx: SignCtx, documentIds: readonly string[]): Promise<Map<string, string | null>> {
  const rows = await inChunks<{ id: string; reference: string | null }>(documentIds, async (chunk) => {
    const { data, error } = await ctx.admin.from("sign_documents").select("id, reference").eq("account_id", ctx.accountId).in("id", chunk);
    if (error) raiseDatabaseError(error, "load documents");
    return (data ?? []) as { id: string; reference: string | null }[];
  });
  return new Map(rows.map((r) => [r.id, r.reference]));
}

export interface JobPage {
  job: BulkJobView;
  rows: BulkRowView[];
  /** The page asked for, so the screen can ask for the next. */
  offset: number;
  hasMore: boolean;
}

/** A batch with its live totals and one page of its people (`limit` 0 for the totals only). */
export async function getBulkJob(ctx: SignCtx, jobId: string, page: { offset: number; limit: number; state?: BulkRowState | null }): Promise<JobPage> {
  const job = await loadJob(ctx, jobId);
  // live totals: at most 500 short rows, so the progress is exact however recently the batch settled
  const states = await ctx.admin.from("sign_bulk_rows").select("state").eq("job_id", jobId).eq("account_id", ctx.accountId);
  if (states.error) raiseDatabaseError(states.error, "count bulk rows");
  const tally: Record<BulkRowState, number> = { pending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const r of (states.data ?? []) as { state: BulkRowState }[]) tally[r.state] = (tally[r.state] ?? 0) + 1;
  const view = viewOf(job, tally);
  if (page.limit <= 0) return { job: view, rows: [], offset: page.offset, hasMore: false };

  const offset = Math.max(0, Math.floor(page.offset));
  const limit = Math.min(200, Math.max(1, Math.floor(page.limit)));
  let q = ctx.admin.from("sign_bulk_rows").select("id, row_no, input, state, document_id, error_code, error_message, claimed_until").eq("job_id", jobId).eq("account_id", ctx.accountId);
  if (page.state) q = q.eq("state", page.state);
  const { data, error } = await q.order("row_no", { ascending: true }).range(offset, offset + limit);
  if (error) raiseDatabaseError(error, "load bulk rows");
  const all = (data ?? []) as BulkRowRow[];
  const rows = all.slice(0, limit);
  const refs = await referencesFor(ctx, rows.map((r) => r.document_id).filter((v): v is string => !!v));
  const now = ctx.now().getTime();
  return {
    job: view,
    rows: rows.map((r) => ({
      rowNo: r.row_no,
      name: r.input?.name ?? "",
      email: r.input?.email ?? "",
      state: r.state,
      documentId: r.document_id,
      reference: r.document_id ? (refs.get(r.document_id) ?? null) : null,
      errorCode: r.error_code,
      errorMessage: r.error_message,
      inFlight: r.state === "pending" && !!r.claimed_until && new Date(r.claimed_until).getTime() > now,
    })),
    offset,
    hasMore: all.length > limit,
  };
}

/** The workspace's recent batches, newest first. */
export async function listBulkJobs(ctx: SignCtx, limit = 20): Promise<BulkJobView[]> {
  const { data, error } = await ctx.admin.from("sign_bulk_jobs").select("*").eq("account_id", ctx.accountId).order("created_at", { ascending: false }).limit(Math.min(50, Math.max(1, limit)));
  if (error) raiseDatabaseError(error, "list bulk jobs");
  return ((data ?? []) as BulkJobRow[]).map((j) => viewOf(j));
}

/** One page of the result file's rows, with each document's reference, in the file's order. */
export async function bulkResultRows(ctx: SignCtx, jobId: string, offset: number, limit: number): Promise<{ rows: ResultRow[]; job: BulkJobRow }> {
  const job = await loadJob(ctx, jobId);
  const { data, error } = await ctx.admin
    .from("sign_bulk_rows")
    .select("row_no, input, state, document_id, error_code, error_message")
    .eq("job_id", jobId)
    .eq("account_id", ctx.accountId)
    .order("row_no", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) raiseDatabaseError(error, "load bulk rows");
  const rows = (data ?? []) as BulkRowRow[];
  const refs = await referencesFor(ctx, rows.map((r) => r.document_id).filter((v): v is string => !!v));
  return {
    job,
    rows: rows.map((r) => ({
      rowNo: r.row_no,
      name: r.input?.name ?? "",
      email: r.input?.email ?? "",
      phone: r.input?.phone ?? null,
      state: r.state,
      reference: r.document_id ? (refs.get(r.document_id) ?? null) : null,
      documentId: r.document_id,
      errorCode: r.error_code,
      errorMessage: r.error_message,
    })),
  };
}

/** Stop a batch. People whose document is being sent right now are finished; everyone else is skipped. */
export async function cancelBulk(ctx: SignCtx, jobId: string): Promise<BulkJobView> {
  const job = await loadJob(ctx, jobId);
  if (job.status !== "queued" && job.status !== "running") throw new SignError("job_finished", "This batch has already finished.", 409);
  const { error } = await ctx.admin.rpc("sign_bulk_stop", {
    p_account: ctx.accountId,
    p_job: jobId,
    p_job_status: "cancelled",
    p_row_state: "skipped",
    p_code: "cancelled",
    p_message: "The batch was cancelled before this document was sent.",
  });
  if (error) raiseDatabaseError(error, "cancel bulk job");
  return (await getBulkJob(ctx, jobId, { offset: 0, limit: 0 })).job;
}

// ---- the runner ----------------------------------------------------------------------------------

/** What a failed row is told about: a code the screen words, and an English sentence for the result file. */
function describeFailure(err: unknown): { code: string; message: string } {
  if (err instanceof UsageLimitError) return { code: "sign_limit_reached", message: err.message };
  if (err instanceof SignError) {
    const issues = err.issues?.length ? ` (${err.issues.map((i) => (i.detail ? `${i.code}:${i.detail}` : i.code)).join(", ")})` : "";
    return { code: err.code, message: `${err.message}${issues}`.slice(0, 500) };
  }
  console.error("[sign] bulk row failed:", err instanceof Error ? err.message : err);
  return { code: "unexpected", message: "Something went wrong while sending this document." };
}

/** Failures that mean no other row of the batch can succeed either: the batch is stopped instead of failing them one by one. */
const FATAL_CODES = new Set(["template_not_found", "template_not_active", "template_has_no_version", "category_not_found"]);

export interface BulkRunResult {
  claimed: number;
  sent: number;
  failed: number;
  released: number;
}

/**
 * Work on waiting rows for a while: claim a batch (the claim takes turns across workspaces, so every one gets a share
 * when several are waiting, and one alone gets all of it), send one document for each until `budgetMs` is used, give back the rows it did not reach. Safe to run twice at once: a row is leased.
 */
export async function runBulk(base: Base, opts: { limit?: number; perAccount?: number; budgetMs?: number; leaseSeconds?: number } = {}): Promise<BulkRunResult> {
  const result: BulkRunResult = { claimed: 0, sent: 0, failed: 0, released: 0 };
  const { data, error } = await base.admin.rpc("sign_bulk_claim", {
    p_limit: opts.limit ?? 30,
    p_per_account: opts.perAccount ?? 30,
    p_lease_seconds: opts.leaseSeconds ?? 300,
    p_max_attempts: 3,
  });
  if (error) {
    console.error("[sign] could not claim bulk rows:", error.message);
    return result;
  }
  const rows = (data ?? []) as BulkRowRow[];
  result.claimed = rows.length;
  if (rows.length === 0) return result;

  const jobIds = [...new Set(rows.map((r) => r.job_id))];
  const jobs = new Map<string, BulkJobRow>();
  for (const job of await inChunks<BulkJobRow>(jobIds, async (chunk) => {
    const q = await base.admin.from("sign_bulk_jobs").select("*").in("id", chunk);
    return (q.data ?? []) as BulkJobRow[];
  })) {
    jobs.set(job.id, job);
  }

  const enabled = new Map<string, boolean>();
  const limitHit = new Set<string>();
  const stopped = new Map<string, { code: string; message: string }>();
  const templates = new Map<string, Promise<{ title: string }>>();

  const ctxFor = (job: BulkJobRow): SignCtx => ({ ...base, accountId: job.account_id, userId: job.created_by, via: `bulk:${job.id}` });

  const stop = async (job: BulkJobRow, status: "failed" | "cancelled" | null, rowState: "failed" | "skipped", code: string, message: string) => {
    const { error: stopError } = await base.admin.rpc("sign_bulk_stop", { p_account: job.account_id, p_job: job.id, p_job_status: status, p_row_state: rowState, p_code: code, p_message: message });
    if (stopError) console.error("[sign] could not stop bulk job:", stopError.message);
  };

  const work = async (row: BulkRowRow): Promise<void> => {
    const job = jobs.get(row.job_id);
    const unreachable = !job || job.account_id !== row.account_id;
    if (unreachable) {
      await base.admin.rpc("sign_bulk_release", { p_ids: [row.id] });
      result.released++;
      return;
    }
    const ctx = ctxFor(job);

    // stopped by an earlier row of this run, or cancelled while this run held the row
    const earlier = stopped.get(job.id);
    if (earlier) {
      await finishRow(ctx, row, { state: "skipped", error_code: earlier.code, error_message: earlier.message });
      return;
    }
    const fresh = await base.admin.from("sign_bulk_jobs").select("status").eq("id", job.id).eq("account_id", job.account_id).maybeSingle();
    const status = (fresh.data as { status?: BulkJobStatus } | null)?.status;
    if (status === "cancelled" || status === "failed") {
      await finishRow(ctx, row, { state: "skipped", error_code: "cancelled", error_message: "The batch was cancelled before this document was sent." });
      return;
    }
    // the module was switched off since the batch was made
    if (!enabled.has(job.account_id)) enabled.set(job.account_id, await signEnabled(base.admin, job.account_id));
    if (!enabled.get(job.account_id)) {
      const why = { code: "sign_disabled", message: "Secure Sign was switched off for this workspace." };
      stopped.set(job.id, why);
      await finishRow(ctx, row, { state: "skipped", error_code: why.code, error_message: why.message });
      await stop(job, "failed", "skipped", why.code, why.message);
      return;
    }

    try {
      const documentId = await sendOne(ctx, job, row);
      await finishRow(ctx, row, { state: "sent", document_id: documentId });
      result.sent++;
    } catch (err) {
      const why = describeFailure(err);
      await finishRow(ctx, row, { state: "failed", error_code: why.code, error_message: why.message });
      result.failed++;
      if (why.code === "sign_limit_reached") {
        // no later row of this workspace's batches can be sent this month: mark them now rather than one by one
        if (!limitHit.has(job.account_id)) {
          limitHit.add(job.account_id);
          await stop(job, null, "failed", why.code, why.message);
        }
      } else if (FATAL_CODES.has(why.code)) {
        stopped.set(job.id, why);
        await stop(job, "failed", "skipped", why.code, why.message);
      }
    }
  };

  const sendOne = async (ctx: SignCtx, job: BulkJobRow, row: BulkRowRow): Promise<string> => {
    // A document made for this row on an earlier try: if it is already out, it is done (never sent twice);
    // if it is still a draft, carry on with it instead of making another.
    let documentId = row.document_id;
    if (documentId) {
      let existing: Awaited<ReturnType<typeof loadDocument>> | null = null;
      try {
        existing = await loadDocument(ctx, documentId);
      } catch (err) {
        if (!(err instanceof SignError && err.code === "document_not_found")) throw err;
      }
      if (existing && existing.status !== "draft") return documentId;
      if (!existing) documentId = null;
    }
    if (!job.template_id) throw new SignError("template_not_found", "That template was not found.", 404);

    if (limitHit.has(ctx.accountId)) throw new UsageLimitError("sign_limit_reached", "This workspace has reached its monthly limit of documents sent for signing.");
    if (!documentId) {
      await assertCanSendDocument(ctx.admin, ctx.accountId);
      const draft = await createDraftFromTemplate(ctx, { templateId: job.template_id, categoryId: job.options.categoryId, contactId: row.input.contactId });
      documentId = draft.id;
      // recorded before anything else happens, so a crash after this point resumes this draft
      const linked = await ctx.admin.from("sign_bulk_rows").update({ document_id: documentId }).eq("id", row.id).eq("account_id", ctx.accountId).eq("state", "pending").select("id");
      if (linked.error || !(linked.data as unknown[] | null)?.length) {
        await deleteDraft(ctx, documentId).catch(() => undefined);
        throw new SignError("row_not_open", "This row was already settled.", 409);
      }
    }

    const draft = await loadDocument(ctx, documentId);
    const base_title = await templateTitle(ctx, job, templates);
    const o = job.options;
    const patch: DraftPatch = { title: titleFor(o.title, base_title, row.input.name), mergeValues: row.input.merge };
    if (o.message !== null) patch.message = o.message;
    if (o.locale) patch.locale = o.locale;
    if (o.expiryDays) patch.expiresAt = expiryIso(ctx.now(), o.expiryDays);
    if (o.codeRequired !== null) patch.codeRequired = o.codeRequired;
    if (o.signInOrder !== null) patch.signInOrder = o.signInOrder;
    if (o.reminderDays !== null) patch.reminderDays = o.reminderDays;
    await updateDraft(ctx, documentId, patch);
    await setSigners(ctx, documentId, buildSigners({ name: row.input.name, email: row.input.email, phone: row.input.phone }, o, draft.roles_snapshot));
    // the people who receive the signed copy of every document of the batch (migration 176): the same list on each, set before sending
    await applyCopyList(ctx, documentId, o.copyTo);
    await sendDocument(ctx, documentId);
    return documentId;
  };

  const { skipped } = await forEachWithinBudget(rows, opts.budgetMs ?? 45_000, work);
  if (skipped.length > 0) {
    const { error: releaseError } = await base.admin.rpc("sign_bulk_release", { p_ids: skipped.map((r) => r.id) });
    if (releaseError) console.error("[sign] could not release bulk rows:", releaseError.message);
    result.released += skipped.length;
  }
  const settle = await base.admin.rpc("sign_bulk_settle", { p_jobs: jobIds });
  if (settle.error) console.error("[sign] could not settle bulk jobs:", settle.error.message);
  return result;
}

/** The title a document of this template starts with (the same the single send uses), read once per batch per run. */
function templateTitle(ctx: SignCtx, job: BulkJobRow, cache: Map<string, Promise<{ title: string }>>): Promise<string> {
  let p = cache.get(job.id);
  if (!p) {
    p = (async () => {
      if (!job.template_id) throw new SignError("template_not_found", "That template was not found.", 404);
      const { template, version } = await loadTemplateFacts(ctx, job.template_id);
      return { title: version.defaults.subject?.trim() || template.name };
    })();
    cache.set(job.id, p);
  }
  return p.then((v) => v.title);
}

/** Record how a row ended. Only a row still waiting is changed: an answer already recorded is never overwritten. */
async function finishRow(ctx: SignCtx, row: BulkRowRow, patch: { state: "sent" | "failed" | "skipped"; document_id?: string; error_code?: string; error_message?: string }): Promise<void> {
  const { error } = await ctx.admin
    .from("sign_bulk_rows")
    .update({ ...patch, claimed_until: null, processed_at: ctx.now().toISOString() })
    .eq("id", row.id)
    .eq("account_id", ctx.accountId)
    .eq("state", "pending");
  if (error) console.error("[sign] could not record a bulk row:", error.message);
}
