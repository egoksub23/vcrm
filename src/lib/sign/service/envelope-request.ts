// ============================================================
// Document collections: how a request that carries documents is read. The same for starting a collection and for adding to one.
//
//   multipart  any number of `file` parts (up to six, 60 MB in all), an `order` (a JSON list that interleaves { kind: "file", index } and
//              { kind: "template", id }), or `templateIds` (a JSON list) with the files first, and the other fields as text
//   JSON       `templateIds`, or an `order` of templates only, and the other fields
//
// A single `file` with `templateIds` and no `order` keeps working as it always did (the file first, then the templates).
// ============================================================

import { UUID_RE, readJson, readUploads } from "../http";
import { parseOrder, type OrderEntry } from "../envelopes";
import { SignError } from "./errors";
import type { EnvelopeUpload } from "./envelopes";

export interface CollectionRequest {
  uploads: EnvelopeUpload[];
  templateIds: string[];
  /** Present when the request named the order of the documents. */
  order: OrderEntry[] | undefined;
  /** The other fields: the text parts of a multipart body, or the JSON body. */
  data: Record<string, unknown>;
}

export function templateIdsOf(raw: unknown): string[] {
  let list: unknown = raw;
  if (typeof raw === "string") {
    try {
      list = JSON.parse(raw);
    } catch {
      list = raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
  }
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.some((x) => typeof x !== "string" || !UUID_RE.test(x))) throw new SignError("template_required", "Choose the templates.", 400);
  return list as string[];
}

const orderOf = (raw: unknown, files: number): OrderEntry[] | undefined => {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const parsed = parseOrder(raw, files);
  if (!parsed.ok) throw new SignError(parsed.code, parsed.code === "envelope_size" ? "A collection holds up to six documents." : parsed.code === "envelope_duplicate_template" ? "Choose each template once." : "The order of the documents is not valid.", 400);
  return parsed.entries;
};

export async function readCollectionRequest(request: Request): Promise<CollectionRequest> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (type.includes("multipart/form-data")) {
    const { files, fields } = await readUploads(request);
    return {
      uploads: files.map((f) => ({ bytes: f.bytes, filename: f.name })),
      templateIds: templateIdsOf(fields.templateIds),
      order: orderOf(fields.order, files.length),
      data: fields,
    };
  }
  const body = await readJson<Record<string, unknown>>(request);
  return { uploads: [], templateIds: templateIdsOf(body.templateIds), order: orderOf(body.order, 0), data: body };
}
