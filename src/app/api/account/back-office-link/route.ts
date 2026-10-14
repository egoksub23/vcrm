// ============================================================
// GET /api/account/back-office-link  (menu.inbox)
//
// How the Inbox reaches the Vircle Back Office page that shows one parent, from the server's settings:
//   baseUrl  BACK_OFFICE_USER_URL, or null when it is unset or not a valid https URL (the Inbox then shows
//            no Back Office action at all)
//   embed    BACK_OFFICE_EMBED is true or 1 (and there is an address): the Inbox shows the Back Office in its
//            panel; false: Search opens a new tab
// Returns these two and nothing else. The link for a contact is built in the browser from the address and the
// phone number the person types or the contact holds, so no phone number ever reaches the server. Any member
// who can open the Inbox may ask. They are an address and a switch, not secrets.
// ============================================================
import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { getBackOfficeBaseUrl, getBackOfficeEmbed } from "@/lib/back-office/config";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireCapability("menu.inbox");
    return NextResponse.json(
      { baseUrl: getBackOfficeBaseUrl(), embed: getBackOfficeEmbed() },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
