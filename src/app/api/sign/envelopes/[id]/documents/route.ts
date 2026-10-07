// ============================================================
// /api/sign/envelopes/[id]/documents   (sign.send)
//
// The documents of a document collection while it is still a draft (a collection that was sent is refused, 409 envelope_not_draft).
//
//   POST  add documents after the ones it has: files of the sender's own, templates, or both, as many as fit (a collection holds up to
//         six: 409 envelope_full). Multipart: any number of `file` parts with an optional `order` (see /api/sign/envelopes) or `templateIds`.
//         JSON: `templateIds` or `order`. All or nothing: when one cannot be made, none is kept.
//   PUT   a new order: JSON `{ order: [document ids] }`, every document of the collection once, first to last.
//
// Removing one document is DELETE ./[documentId].
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { addEnvelopeDocuments, reorderEnvelopeDocuments } from "@/lib/sign/service/envelope-documents";
import { readCollectionRequest } from "@/lib/sign/service/envelope-request";
import type { SignDocumentRow } from "@/lib/sign/types";

type Params = { params: Promise<{ id: string }> };

async function idOf(params: Params["params"]): Promise<string> {
  const { id } = await params;
  if (!UUID_RE.test(id)) throw new SignError("envelope_not_found", "That document collection was not found.", 404);
  return id;
}

const brief = (d: SignDocumentRow) => ({ id: d.id, reference: d.reference, title: d.title, position: d.envelope_position ?? 0, pageCount: d.page_count });

export async function POST(request: Request, { params }: Params) {
  return staff(
    "sign.send",
    request,
    async ({ ctx }) => {
      const id = await idOf(params);
      const body = await readCollectionRequest(request);
      const made = await addEnvelopeDocuments(ctx, id, { files: body.uploads, templateIds: body.templateIds, order: body.order });
      return json({ added: made.added.map(brief), documents: made.documents.map(brief) }, 201);
    },
    { rate: { limit: 20, windowMs: 60_000 } },
  );
}

export async function PUT(request: Request, { params }: Params) {
  return staff("sign.send", request, async ({ ctx }) => {
    const id = await idOf(params);
    const body = await readJson<{ order?: unknown }>(request);
    if (!Array.isArray(body.order) || body.order.some((x) => typeof x !== "string" || !UUID_RE.test(x))) throw new SignError("bad_order", "The order must name every document of the collection once.", 400);
    const made = await reorderEnvelopeDocuments(ctx, id, body.order as string[]);
    return json({ documents: made.documents.map(brief) });
  });
}
