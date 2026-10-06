// ============================================================
// Taking documents out of Doc Sign in bulk, as streams so nothing large is held in memory:
//
//   documentsCsvStream   the documents list as a CSV (reads pages of 500, at most 50,000 documents)
//   planZip / zipStream  the signed files of up to 50 completed documents as one zip (reads one file at a time)
//
// Both run with the service-role client and read only the workspace's own rows. Each document put in a zip is
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
import { getFile } from "../storage";
import { loadSenderAndWorkspace, logEvent, type SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";

const SELECT = "reference, title, status, mode, category_id, created_at, sent_at, completed_at, expires_at, contacts(name), sign_signers(full_name, order_no)";
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
      const all = ctx.admin.from("sign_documents").select(SELECT).eq("account_id", ctx.accountId);
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

export interface ZipPlan {
  included: ZipCandidate[];
  skipped: ZipSkip[];
}

/**
 * Decide which of the chosen documents go in the zip. Throws `nothing_to_download` (409, with the reasons) when none
 * can, and leaves the last ones out (reason `too_large`) when the known sizes together pass the limit.
 */
export async function planZip(ctx: SignCtx, ids: readonly string[]): Promise<ZipPlan> {
  const found: ZipCandidate[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await ctx.admin.from("sign_documents").select("id, reference, title, status, final_path").eq("account_id", ctx.accountId).in("id", ids.slice(i, i + IN_CHUNK));
    if (error) raiseDatabaseError(error, "load documents for the zip");
    found.push(...((data ?? []) as ZipCandidate[]));
  }
  const plan = classifyForZip(ids, found);

  if (plan.included.length > 0) {
    const sizes = new Map<string, number>();
    for (let i = 0; i < plan.included.length; i += IN_CHUNK) {
      const chunk = plan.included.slice(i, i + IN_CHUNK).map((d) => d.id);
      const { data } = await ctx.admin.from("sign_document_files").select("document_id, size_bytes").eq("account_id", ctx.accountId).eq("kind", "signed").in("document_id", chunk);
      for (const f of (data ?? []) as { document_id: string; size_bytes: number }[]) sizes.set(f.document_id, Number(f.size_bytes) || 0);
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
  return plan;
}

/** The zip, as chunks. A file that cannot be read is left out and listed in the note; the others still come. */
export function zipStream(ctx: SignCtx, plan: ZipPlan): ReadableStream<Uint8Array> {
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
    const used = new Set<string>();
    const skipped = [...plan.skipped];
    let total = 0;

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
      // a PDF is already compressed: stored as it is
      const entry = new ZipPassThrough(zipEntryName(d, used));
      zip.add(entry);
      entry.push(bytes, true);
      await logEvent(ctx, d.id, "downloaded", { actor: "user", userId: ctx.userId, detail: { kind: "final", source: "zip" } });
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
