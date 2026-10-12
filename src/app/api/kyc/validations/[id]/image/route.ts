// ============================================================
// GET /api/kyc/validations/[id]/image[?friend_id=<id>]   (menu.kyc and kyc.view)
//
// The stored ID image of one validation, fetched from the back end on the server and streamed back. It is never stored in Halo and the back end's
// signed URL never reaches the browser:
//   1. the back end is asked for a signed URL (GET /validations/{id}/url, with the key, which stays here)
//   2. the URL is checked (https, a public DNS name, the back end's own domain or KYC_DOC_ALLOWED_IMAGE_HOSTS, no redirects) before anything is fetched
//   3. the image is fetched with a 10 s deadline and a 15 MB cap; only JPEG, PNG and WebP are served (a PDF is refused on purpose), and the first bytes
//      must be that type's
//   4. the access log row ('view_image') is written; when it cannot be written the bytes are dropped
// The answer carries no-store headers so no cache (browser, proxy) keeps a child's ID, and nosniff so it can only be treated as the image it is.
// `friend_id` is for the access log only. 120 a minute per person.
// ============================================================
import { NextResponse } from "next/server";

import { failure, kycStaff } from "@/lib/kyc/http";
import { logFriendId } from "@/lib/kyc/audit";
import { fetchValidationImage, validValidationId } from "@/lib/kyc/service";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return kycStaff({ bucket: "image", perMinute: 120 }, async ({ admin, caller, runtime }) => {
    const { id: rawId } = await params;
    let id = rawId;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return failure("invalid_request");
    }
    if (!validValidationId(id)) return failure("invalid_request");
    const friendId = logFriendId(new URL(request.url).searchParams.get("friend_id"));

    const result = await fetchValidationImage(admin, caller, runtime, { validationId: id, friendId });
    if (!result.ok) return failure(result.code);
    return new NextResponse(result.body.bytes as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": result.body.contentType,
        "Content-Length": String(result.body.bytes.byteLength),
        "Content-Disposition": "inline",
        "Cache-Control": "no-store, no-cache, private",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  });
}
