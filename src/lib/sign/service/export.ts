// ============================================================
// Taking documents out of Doc Sign in bulk, as streams so nothing large is held in memory:
//
//   documentsCsvStream   the documents list as a CSV (reads pages of 500, at most 50,000 documents)
//   planZip / zipStream  the signed files of up to 50 completed documents as one zip (reads one file at a time), each with its
//                        certificate when that is a file of its own (migration 178)
//   planEnvelopeZip      the same for the documents of one collection, with a "Collection summary" PDF in front: the one download
//                        of a collection ("Download all (zip)"); it is planZip and zipStream with an extra file, not a second zip builder
//
// All run with the service-role client and read only the workspace's own rows. Each document put in a zip is
// recorded in its history as `downloaded`, the same event as opening the signed copy.
// ============================================================

import { Zip, ZipDeflate, ZipPassThrough, strToU8 } from "fflate";

import { signerSearchClause, searchClause } from "../client/list-filters";
import {
  EXPORT_MAX_ROWS,
  EXPORT_PAGE_SIZE,
  applyExportFilters,
  createdRange,
  exportHeaderLine,
  exportLines,
  type ExportDocRow,
  type ExportFilters,
} from "../export/documents";
import { ZIP_MAX_BYTES, ZIP_SKIPPED_NOTE, classifyForZip, skippedNote, zipEntryName, type ZipCandidate, type ZipSkip } from "../export/zip";
import { COLLECTION_SUMMARY_FILE, collectionSummaryLabels } from "../collection-summary-words";
import { buildCollectionSummary } from "../pdf/certificate";
import type { CollectionSummaryDocument } from "../pdf/types";
import { getFile } from "../storage";
import { isFormMode, type SignDocumentRow, type SignEnvelopeRow } from "../types";
import { loadSenderAndWorkspace, logEvent, type SignCtx } from "./context";
import { loadEnvelope, loadEnvelopeDocuments, loadEnvelopeSigners } from "./envelope-data";
import { SignError, raiseDatabaseError } from "./errors";
import { documentListScope, visibleDocuments } from "./privacy";
import { signedPeople } from "./verify";

const SELECT = "reference, title, status, mode, category_id, created_at, sent_at, completed_at, expires_at, cancelled_at, contacts(name), sign_signers(full_name, order_no)";
const IN_CHUNK = 100;

/** A pull-based web stream over an async generator: the next chunk is made only when the reader asks for it. */
function streamOf(gen: AsyncGenerator<Uint8Array>): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        console.error("[sign] export stream failed:", err instanceof Error ? err.message : err);
        controller.error(err);
      }
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}

// ---- the documents list as CSV ------------------------------------------------------------------

/** The documents the filters ask for, newest first, as CSV (UTF-8 with a BOM so Excel reads names as UTF-8). */
export function documentsCsvStream(ctx: SignCtx, filters: ExportFilters, opts: { maxRows?: number; pageSize?: number } = {}): ReadableStream<Uint8Array> {
  const maxRows = opts.maxRows ?? EXPORT_MAX_ROWS;
  const pageSize = Math.min(opts.pageSize ?? EXPORT_PAGE_SIZE, 1000);
  const encoder = new TextEncoder();

  async function* chunks(): AsyncGenerator<Uint8Array> {
    // the category names and the day bounds are read once, before the first row
    const cats = await ctx.admin.from("sign_categories").select("id, name").eq("account_id", ctx.accountId);
    if (cats.error) raiseDatabaseError(cats.error, "load categories");
    const categoryNames = new Map(((cats.data ?? []) as { id: string; name: string }[]).map((c) => [c.id, c.name]));
    const { timeZone } = await loadSenderAndWorkspace(ctx, null);
    const range = createdRange(filters, timeZone);
    // a private document is in the file only for the people who may see it (migration 176, service/privacy.ts)
    const scope = await documentListScope(ctx);

    // a search also finds the documents a matching person is on (the list's own rule)
    let signerDocs: string[] = [];
    const signerClause = signerSearchClause(filters.search);
    if (signerClause) {
      const m = await ctx.admin.from("sign_signers").select("document_id").eq("account_id", ctx.accountId).or(signerClause).limit(200);
      if (m.error) raiseDatabaseError(m.error, "search signers");
      signerDocs = [...new Set(((m.data ?? []) as { document_id: string }[]).map((r) => r.document_id))];
    }
    const clause = searchClause(filters.search, signerDocs);

    yield encoder.encode("\uFEFF" + exportHeaderLine());
    for (let offset = 0; offset < maxRows; ) {
      const take = Math.min(pageSize, maxRows - offset);
      // test documents (F-10) are rehearsals, not records: the file leaves them out, unless the Test group itself is what was asked for
      const all = scope.apply(ctx.admin.from("sign_documents").select(SELECT).eq("account_id", ctx.accountId));
      const base = filters.group === "test" ? all.eq("test", true) : all.neq("test", true);
      const { data, error } = await applyExportFilters(base, filters, clause, range)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + take - 1);
      if (error) raiseDatabaseError(error, "export documents");
      const rows = (data ?? []) as unknown as ExportDocRow[];
      if (rows.length > 0) yield encoder.encode(exportLines(rows, categoryNames));
      offset += rows.length;
      if (rows.length < take) return;
    }
  }
  return streamOf(chunks());
}

// ---- the signed files as a zip -------------------------------------------------------------------

/** The names a document's files get in the zip: its signed file, and its certificate when that is a file of its own. */
export interface ZipNames {
  signed: string;
  certificate: string | null;
}

export interface ZipPlan {
  included: ZipCandidate[];
  skipped: ZipSkip[];
  /** The names in the zip, by document id (decided with the plan so a summary can name the files). Made when the zip is made if absent. */
  names?: Map<string, ZipNames>;
}

/** The names of the files of the documents that go in, each different from the others (the comparison ignores case). */
function namesFor(included: readonly ZipCandidate[]): Map<string, ZipNames> {
  const used = new Set<string>();
  return new Map(included.map((d) => [d.id, { signed: zipEntryName(d, used), certificate: d.certificate_path ? zipEntryName(d, used, "certificate") : null }]));
}

/**
 * Decide which of the chosen documents go in the zip. Throws `nothing_to_download` (409, with the reasons) when none
 * can, and leaves the last ones out (reason `too_large`) when the known sizes together pass the limit.
 */
export async function planZip(ctx: SignCtx, ids: readonly string[]): Promise<ZipPlan> {
  const found: ZipCandidate[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await ctx.admin.from("sign_documents").select("id, reference, title, status, final_path, certificate_path, is_private, created_by, envelope_id").eq("account_id", ctx.accountId).in("id", ids.slice(i, i + IN_CHUNK));
    if (error) raiseDatabaseError(error, "load documents for the zip");
    // a private document the caller may not see is not found, as if it were not there (it is not named in the zip's note either)
    for (const row of await visibleDocuments(ctx, (data ?? []) as (ZipCandidate & { is_private?: boolean; created_by?: string | null; envelope_id?: string | null })[])) {
      const { is_private: _private, created_by: _by, envelope_id: _envelope, ...candidate } = row;
      void _private;
      void _by;
      void _envelope;
      found.push(candidate);
    }
  }
  const plan = classifyForZip(ids, found);

  if (plan.included.length > 0) {
    const sizes = new Map<string, number>();
    for (let i = 0; i < plan.included.length; i += IN_CHUNK) {
      const chunk = plan.included.slice(i, i + IN_CHUNK).map((d) => d.id);
      // the signed file and, from migration 178, the certificate file beside it
      const { data } = await ctx.admin.from("sign_document_files").select("document_id, size_bytes").eq("account_id", ctx.accountId).in("kind", ["signed", "certificate"]).in("document_id", chunk);
      for (const f of (data ?? []) as { document_id: string; size_bytes: number }[]) sizes.set(f.document_id, (sizes.get(f.document_id) ?? 0) + (Number(f.size_bytes) || 0));
    }
    let total = 0;
    const kept: ZipCandidate[] = [];
    for (const d of plan.included) {
      const size = sizes.get(d.id) ?? 0;
      if (total + size > ZIP_MAX_BYTES && kept.length > 0) plan.skipped.push({ id: d.id, reference: d.reference, reason: "too_large" });
      else {
        total += size;
        kept.push(d);
      }
    }
    plan.included = kept;
  }
  if (plan.included.length === 0) throw new SignError("nothing_to_download", "None of the chosen documents has a signed file to download.", 409, plan.skipped.map((s) => ({ code: s.reason, detail: s.reference ?? s.id })));
  return { ...plan, names: namesFor(plan.included) };
}

/** A file to put in the zip that is not one of the documents' own (the collection's summary). */
export interface ZipExtra {
  name: string;
  bytes: Uint8Array;
}

/**
 * The zip, as chunks: for each document its signed file, then its certificate when that is a file of its own. A file that cannot be read is left out and
 * listed in the note; the others still come. `extras` go in first. `log: false` is for a person who is not signed in (a signer's own download), whose
 * downloads are not recorded, as the signed copy on their page never was.
 */
export function zipStream(ctx: SignCtx, plan: ZipPlan, opts: { extras?: readonly ZipExtra[]; log?: boolean } = {}): ReadableStream<Uint8Array> {
  async function* chunks(): AsyncGenerator<Uint8Array> {
    const out: Uint8Array[] = [];
    let failure: Error | null = null;
    const zip = new Zip((err, chunk) => {
      if (err) failure = err;
      else out.push(chunk);
    });
    function* flush(): Generator<Uint8Array> {
      if (failure) throw failure;
      while (out.length > 0) yield out.shift() as Uint8Array;
    }
    const names = plan.names ?? namesFor(plan.included);
    const skipped = [...plan.skipped];
    let total = 0;

    // a PDF is already compressed: stored as it is
    const store = (name: string, bytes: Uint8Array) => {
      const entry = new ZipPassThrough(name);
      zip.add(entry);
      entry.push(bytes, true);
    };
    for (const extra of opts.extras ?? []) {
      store(extra.name, extra.bytes);
      yield* flush();
    }

    for (const d of plan.included) {
      let bytes: Uint8Array;
      try {
        bytes = await getFile(ctx.admin, d.final_path!, ctx.accountId);
      } catch {
        skipped.push({ id: d.id, reference: d.reference, reason: "read_failed" });
        continue;
      }
      // sizes in the files table can be missing or stale: the running total is what holds the limit
      if (total + bytes.byteLength > ZIP_MAX_BYTES) {
        skipped.push({ id: d.id, reference: d.reference, reason: "too_large" });
        continue;
      }
      total += bytes.byteLength;
      const name = names.get(d.id) ?? { signed: zipEntryName(d, new Set()), certificate: null };
      store(name.signed, bytes);
      // its certificate, a file of its own: never left out for size (it is small, and the zip is not a zip without it); one that cannot be read is named in the note
      if (d.certificate_path && name.certificate) {
        try {
          const certificate = await getFile(ctx.admin, d.certificate_path, ctx.accountId);
          total += certificate.byteLength;
          store(name.certificate, certificate);
        } catch {
          skipped.push({ id: d.id, reference: d.reference, reason: "certificate_read_failed" });
        }
      }
      if (opts.log !== false) await logEvent(ctx, d.id, "downloaded", { actor: "user", userId: ctx.userId, detail: { kind: "final", source: "zip" } });
      yield* flush();
    }

    const note = skippedNote(skipped);
    if (note) {
      const f = new ZipDeflate(ZIP_SKIPPED_NOTE, { level: 6 });
      zip.add(f);
      f.push(strToU8(note), true);
    }
    zip.end();
    yield* flush();
  }
  return streamOf(chunks());
}

// ---- a collection's zip ------------------------------------------------------------------------------

/**
 * The one download of a document collection: every signed document and its certificate, with a small "Collection summary" PDF in front (the
 * collection's reference and title, and for each document its fingerprint and who signed). The documents are the ones of the collection that the
 * caller may see (`only` narrows them: a signer is given the documents they are on and nothing about the others). It is `planZip` over the
 * collection's documents, and its zip is `zipStream` with the summary as an extra file. Throws `nothing_to_download` (409) when none has a signed file.
 */
export async function planEnvelopeZip(
  ctx: SignCtx,
  envelopeId: string,
  opts: { only?: ReadonlySet<string> } = {},
): Promise<{ plan: ZipPlan; extras: ZipExtra[]; fileName: string }> {
  const env = await loadEnvelope(ctx, envelopeId);
  const docs = (await loadEnvelopeDocuments(ctx, envelopeId)).filter((d) => !opts.only || opts.only.has(d.id));
  if (docs.length === 0) throw new SignError("nothing_to_download", "This document collection has no document to download.", 409);
  const plan = await planZip(ctx, docs.map((d) => d.id));
  const extras = [await collectionSummaryFile(ctx, env, docs, plan)];
  return { plan, extras, fileName: `${safeZipStem(env.reference ?? env.title)}.zip` };
}

/** A reference made safe for a file name. */
const safeZipStem = (s: string): string => s.replace(/[^\w.\- ]+/g, "").trim().slice(0, 80) || "collection";

async function collectionSummaryFile(ctx: SignCtx, env: SignEnvelopeRow, docs: readonly SignDocumentRow[], plan: ZipPlan): Promise<ZipExtra> {
  const [info, rows] = await Promise.all([loadSenderAndWorkspace(ctx, env.created_by), loadEnvelopeSigners(ctx, plan.included.map((d) => d.id))]);
  const names = plan.names ?? namesFor(plan.included);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const position = new Map(docs.map((d, i) => [d.id, i + 1]));
  const entries: CollectionSummaryDocument[] = [];
  for (const c of plan.included) {
    const d = byId.get(c.id);
    const name = names.get(c.id);
    if (!d || !name || !d.final_sha256) continue;
    entries.push({
      number: position.get(d.id) ?? entries.length + 1,
      title: d.title,
      reference: d.reference ?? d.id,
      fileName: name.signed,
      sha256: d.final_sha256,
      ...(name.certificate && d.certificate_sha256 ? { certificateFileName: name.certificate, certificateSha256: d.certificate_sha256 } : {}),
      signers: signedPeople(rows.filter((r) => r.document_id === d.id), d.mode).map((p) => ({ name: p.name, ...(p.signedAt ? { signedAt: new Date(p.signedAt) } : {}) })),
    });
  }
  const mode = docs.length > 0 && docs.every((d) => isFormMode(d)) ? "form" : "sign";
  const built = await buildCollectionSummary(
    {
      reference: env.reference ?? env.id,
      title: env.title,
      workspaceName: info.workspaceName,
      preparedAt: ctx.now(),
      timeZone: info.timeZone,
      documents: entries,
      ...(env.cancelled_at ? { cancelledAt: new Date(env.cancelled_at) } : {}),
      labels: collectionSummaryLabels(env.locale, mode),
    },
    { locale: env.locale },
  );
  return { name: COLLECTION_SUMMARY_FILE, bytes: built.bytes };
}
