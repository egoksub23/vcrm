// ============================================================
// /api/sign/envelopes/[id]/copies
//
//   GET   (menu.sign)  the people who receive a copy of this document collection (name, email, and when the signed copies were sent to each)
//   POST  (sign.send)  add one person: { fullName, email }
//   PUT   (sign.send)  make the list exactly { copies: [{ fullName, email }] }
//
// A person who receives a copy is not a signer: no link, no turn. When every document of the collection is signed and sealed they get ONE
// email with all the signed PDFs. Added or removed while the collection is a draft or open (not once it is completed), at most 10.
// ============================================================
import { UUID_RE, json, readJson, staff } from "@/lib/sign/http";
import { loadEnvelope } from "@/lib/sign/service/envelope-data";
import { addCopyRecipient, listCopyRecipients, parseCopyList, setCopyRecipients } from "@/lib/sign/service/copy-recipients";
import { SignError } from "@/lib/sign/service/errors";

type Params = { params: Promise<{ id: string }> };

async function idOf(params: Params["params"]): Promise<string> {
  const { id } = await params;
  if (!UUID_RE.test(id)) throw new SignError("envelope_not_found", "That document collection was not found.", 404);
  return id;
}

export async function GET(request: Request, { params }: Params) {
  return staff("menu.sign", request, async ({ ctx }) => {
    const id = await idOf(params);
    // a collection of another workspace is "not found", like a missing one (not an empty list)
    await loadEnvelope(ctx, id);
    return json({ copies: await listCopyRecipients(ctx, { envelopeId: id }) });
  });
}

export async function POST(request: Request, { params }: Params) {
  return staff("sign.send", request, async ({ ctx }) => {
    const id = await idOf(params);
    const body = await readJson<{ fullName?: unknown; full_name?: unknown; email?: unknown }>(request);
    const copy = await addCopyRecipient(ctx, { envelopeId: id }, { fullName: String(body.fullName ?? body.full_name ?? ""), email: String(body.email ?? "") });
    return json({ copy }, 201);
  });
}

export async function PUT(request: Request, { params }: Params) {
  return staff("sign.send", request, async ({ ctx }) => {
    const id = await idOf(params);
    const body = await readJson<{ copies?: unknown }>(request);
    return json({ copies: await setCopyRecipients(ctx, { envelopeId: id }, parseCopyList(body.copies)) });
  });
}
