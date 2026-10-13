// ============================================================
// Compliance requests, the personal closure form: the HTTP edge of its one public route (POST /api/compliance/form-link/submit). SERVER ONLY.
// What the route answers for each outcome: always JSON, always `no-store`, a CODE (the page words it in the parent's language), never a link, a stored
// answer, the database's words, or which of the reasons a link does not work.
// ============================================================

import type { NextResponse } from "next/server";

import { publicJson } from "../public/http";
import type { LinkSubmitOutcome } from "./public";

export function linkSubmitResponse(o: LinkSubmitOutcome): NextResponse {
  switch (o.kind) {
    case "ok":
      return publicJson({ ok: true, reference: o.reference });
    case "declined":
      return publicJson({ ok: true, declined: true });
    case "invalid":
      return publicJson({ code: "invalid", problems: o.problems }, 400);
    case "retry":
      return publicJson({ code: o.code, token: o.token }, 400);
    case "rate_limited":
      return publicJson({ code: "rate_limited" }, 429);
    case "failed":
      return publicJson({ code: "failed" }, 503);
    case "not_configured":
      return publicJson({ code: "unavailable" }, 503);
    default:
      return publicJson({ code: "not_found" }, 404);
  }
}
