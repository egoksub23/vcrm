// ============================================================
// /api/sign/public/[token]/upload   (a file for a field of the signer's own form)
//
//   POST    multipart `field` (the data field's key) and `file`            -> { file, progress, ready }
//   DELETE  ?field=<key>&id=<file id>                                       -> { progress, ready }
//   GET     ?field=<key>&id=<file id>   the signer's own file, inline, for a preview
//
// The kind of file is decided from its first bytes (PDF, JPEG or PNG), then the field's own limits (kinds,
// size, count) and 50 MB for the whole document. The storage path never leaves the server. When a code is
// required it must have been entered.
// ============================================================
import { NextResponse } from "next/server";

import { MAX_UPLOAD_MB } from "@/lib/sign/forms";
import { json, publicLink, readUpload } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { codeRequiredFor } from "@/lib/sign/service/signing";
import { readOwnUpload, removeUpload, uploadFile } from "@/lib/sign/service/uploads";

type Params = { params: Promise<{ token: string }> };

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The largest file a field can take, plus the envelope of a multipart body. */
const BODY_MAX = MAX_UPLOAD_MB * 1024 * 1024 + 256 * 1024;

function target(request: Request): { field: string; id: string } {
  const url = new URL(request.url);
  const field = url.searchParams.get("field") ?? "";
  const id = url.searchParams.get("id") ?? "";
  if (!KEY_RE.test(field) || !ID_RE.test(id)) throw new SignError("bad_request", "Say which file.", 400);
  return { field, id };
}

export async function POST(request: Request, { params }: Params) {
  return publicLink(
    request,
    params,
    async ({ ctx, lookup, sessionOk }) => {
      if (codeRequiredFor(lookup) && !sessionOk) throw new SignError("code_required", "Enter the code first.", 403);
      const { file, fields } = await readUpload(request, BODY_MAX);
      return json(await uploadFile(ctx, lookup, { field: fields.field ?? "", file }), 201);
    },
    { rate: { limit: 30, windowMs: 60_000 } },
  );
}

export async function DELETE(request: Request, { params }: Params) {
  return publicLink(
    request,
    params,
    async ({ ctx, lookup, sessionOk }) => {
      if (codeRequiredFor(lookup) && !sessionOk) throw new SignError("code_required", "Enter the code first.", 403);
      return json(await removeUpload(ctx, lookup, target(request)));
    },
    { rate: { limit: 60, windowMs: 60_000 } },
  );
}

export async function GET(request: Request, { params }: Params) {
  return publicLink(request, params, async ({ ctx, lookup, sessionOk }) => {
    if (codeRequiredFor(lookup) && !sessionOk) throw new SignError("code_required", "Enter the code first.", 403);
    const file = await readOwnUpload(ctx, lookup, target(request));
    return new NextResponse(Buffer.from(file.bytes), {
      status: 200,
      headers: {
        "Content-Type": file.mime,
        "Content-Length": String(file.bytes.byteLength),
        "Content-Disposition": `inline; filename="${file.name.replace(/["\\\r\n]/g, "")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
