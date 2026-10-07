// ============================================================
// /api/sign/documents/[id]/copies
//
//   GET   (menu.sign)  the people who receive a copy of this document (name, email, and when the signed copy was sent to each)
//   POST  (sign.send)  add one person: { fullName, email }
//   PUT   (sign.send)  make the list exactly { copies: [{ fullName, email }] } (the draft screen saves its whole list this way)
//
// A person who receives a copy is not a signer: no link, no turn, nothing to do until the signed copy arrives by email. Added or removed
// while the document is a draft or open (not once it is completed), at most 10. A document that is part of a collection takes none of its
// own: they are added to the collection (409 document_in_envelope).
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { loadDocument } from "@/lib/sign/service/context";
import { addCopyRecipient, listCopyRecipients, parseCopyList, setCopyRecipients } from "@/lib/sign/service/copy-recipients";
import { SignError } from "@/lib/sign/service/errors";

type Params = { params: Promise<{ id: string }> };

async function idOf(params: Params["params"]): Promise<string> {
  const { id } = await params;
  if (!UUID_RE.test(id)) throw new SignError("document_not_found", "That document was not found.", 404);
  return id;
}

export async function GET(request: Request, { params }: Params) {
  return staff("menu.sign", request, async ({ ctx }) => {
    const id = await idOf(params);
    // a document of another workspace is "not found", like a missing one (not an empty list)
    await loadDocument(ctx, id);
    return json({ copies: await listCopyRecipients(ctx, { documentId: id }) });
  });
}

export async function POST(request: Request, { params }: Params) {
  return staff("sign.send", request, async ({ ctx }) => {
    const id = await idOf(params);
    const body = await readJson<{ fullName?: unknown; full_name?: unknown; email?: unknown }>(request);
    const copy = await addCopyRecipient(ctx, { documentId: id }, { fullName: String(body.fullName ?? body.full_name ?? ""), email: String(body.email ?? "") });
    return json({ copy }, 201);
  });
}

export async function PUT(request: Request, { params }: Params) {
  return staff("sign.send", request, async ({ ctx }) => {
    const id = await idOf(params);
    const body = await readJson<{ copies?: unknown }>(request);
    return json({ copies: await setCopyRecipients(ctx, { documentId: id }, parseCopyList(body.copies)) });
  });
}
