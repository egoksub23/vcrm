// ============================================================
// POST /api/compliance/requests/[id]/files   (compliance.review or compliance.approve)
//
// Multipart: one `file` (PDF, JPEG or PNG by its first bytes, at most 10 MB) and optionally `field` (the file field of the type it answers, for example
// authorization_letter). Stored in the private bucket compliance-files; recorded with its SHA-256 and an 'attachment' event. Files cannot be changed or
// removed afterwards. 20 a minute per person.
// ============================================================
import { ComplianceError } from "@/lib/compliance/errors";
import { complianceStaff, failure, json, UUID_RE } from "@/lib/compliance/http";
import { MAX_FILE_BYTES, uploadFile } from "@/lib/compliance/service/files";
import { readBodyCapped } from "@/lib/net/read-capped";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return complianceStaff({ bucket: "upload", perMinute: 20, needAny: ["compliance.review", "compliance.approve"] }, async ({ admin, caller }) => {
    const { id } = await params;
    if (!UUID_RE.test(id)) return failure("not_found");
    const cap = MAX_FILE_BYTES + 200_000;
    const declared = Number(request.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > cap) throw new ComplianceError("file_too_large", "That file is larger than 10 MB.", 413);
    const raw = await readBodyCapped(request, cap);
    if (raw === null) throw new ComplianceError("file_too_large", "That file is larger than 10 MB.", 413);
    const form = await new Response(raw as unknown as BodyInit, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData().catch(() => null);
    if (!form) throw new ComplianceError("unsupported_file", "The upload could not be read.", 400);
    const file = form.get("file");
    if (!(file instanceof File)) throw new ComplianceError("unsupported_file", "Choose a file to upload.", 400);
    const field = form.get("field");
    const uploaded = await uploadFile(admin, caller, id, { bytes: new Uint8Array(await file.arrayBuffer()), name: file.name || "file" }, typeof field === "string" && field !== "" ? field : null);
    return json(uploaded, 201);
  });
}
