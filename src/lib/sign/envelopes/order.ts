// ============================================================
// Doc Sign document collections (the envelopes of migration 171): ONE ordered list of the documents a collection is made of, files of the
// sender's own and templates interleaved. The browser builds it and sends it as the `order` field next to the `file` parts; the server reads
// it with `parseOrder` and makes the documents in that order. Pure: no Node, no database.
//
//   { "kind": "file", "index": 0, "title": "Optional title" }     the n-th `file` part of the upload (0 is the first one sent)
//   { "kind": "template", "id": "<template id>", "title": "..." }  an active template
// ============================================================

import { ENVELOPE_MAX_DOCUMENTS } from "./status";

export type OrderEntry = { kind: "file"; index: number; title?: string } | { kind: "template"; id: string; title?: string };

export type OrderFailure = "bad_order" | "envelope_size" | "envelope_duplicate_template";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_MAX = 200;

/** A title typed by the sender: trimmed, one line, at most 200 characters; empty is "no title" (the file name or the template's name is used). */
export function cleanTitle(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.replace(/[\r\n\t]+/g, " ").trim().slice(0, TITLE_MAX);
  return t === "" ? undefined : t;
}

/**
 * Read an `order` (the JSON text of the multipart field, or the list itself). `files` is how many `file` parts arrived. Every file part must
 * be named exactly once (a file that is not in the list would be silently dropped), a template at most once, and the list is at most six long
 * (the size is checked again, with the minimum, by the service that makes the documents).
 */
export function parseOrder(raw: unknown, files: number): { ok: true; entries: OrderEntry[] } | { ok: false; code: OrderFailure } {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      return { ok: false, code: "bad_order" };
    }
  }
  if (!Array.isArray(list)) return { ok: false, code: "bad_order" };
  if (list.length > ENVELOPE_MAX_DOCUMENTS) return { ok: false, code: "envelope_size" };
  const entries: OrderEntry[] = [];
  const usedFiles = new Set<number>();
  const usedTemplates = new Set<string>();
  for (const item of list) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return { ok: false, code: "bad_order" };
    const x = item as Record<string, unknown>;
    const title = cleanTitle(x.title);
    if (x.kind === "file") {
      const i = x.index;
      if (typeof i !== "number" || !Number.isInteger(i) || i < 0 || i >= files || usedFiles.has(i)) return { ok: false, code: "bad_order" };
      usedFiles.add(i);
      entries.push({ kind: "file", index: i, ...(title ? { title } : {}) });
    } else if (x.kind === "template") {
      const id = x.id;
      if (typeof id !== "string" || !UUID.test(id)) return { ok: false, code: "bad_order" };
      if (usedTemplates.has(id.toLowerCase())) return { ok: false, code: "envelope_duplicate_template" };
      usedTemplates.add(id.toLowerCase());
      entries.push({ kind: "template", id, ...(title ? { title } : {}) });
    } else {
      return { ok: false, code: "bad_order" };
    }
  }
  if (usedFiles.size !== files) return { ok: false, code: "bad_order" };
  return { ok: true, entries };
}

/** The order of the documents when none is sent: the files as they came, then the templates (what a single file followed by templates always meant). */
export function defaultOrder(files: number, templateIds: readonly string[]): OrderEntry[] {
  return [...Array.from({ length: files }, (_, index): OrderEntry => ({ kind: "file", index })), ...templateIds.map((id): OrderEntry => ({ kind: "template", id }))];
}
