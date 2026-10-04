// ============================================================
// GET /api/account/urls  (channels.manage)
//
// Every address Halo expects to be registered with another service (Meta,
// Microsoft, Google, TikTok, Atlassian, Supabase, the chat gateway, the widget),
// at this deployment's canonical address: NEXT_PUBLIC_SITE_URL when it is set,
// otherwise the address the request came in on. Also returns the address the
// request used, so the screen can say when it is being viewed through an older
// alias (crm.vircle.tech) and the addresses shown are those of the new one.
// ============================================================
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { getOAuthBaseUrl } from "@/lib/meta/oauth";
import { registeredUrls } from "@/lib/platform/registered-urls";

export async function GET(request: Request) {
  try {
    await requireCapability("channels.manage");
    const base = getOAuthBaseUrl(request);
    const forwarded = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
    const viewedHost = forwarded || request.headers.get("host") || "";
    return NextResponse.json(
      { base, viewedHost, groups: registeredUrls(base) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
