// ============================================================
// POST /api/sign/public/[token]/code/verify   { code }
//
// Check the code the signer typed. Every try is counted in the database before it is compared, so guesses
// cannot race; five wrong tries lock the code until a new one is sent. A right code opens a session for
// this signer, valid for twelve hours, as a cookie that only the server can read.
// ============================================================
import { NextResponse } from "next/server";

import { failure, json, publicLink, readJson, sessionCookie, sharedLimit } from "@/lib/sign/http";
import { SignError } from "@/lib/sign/service/errors";
import { verifyCode } from "@/lib/sign/service/signing";
import { createSession, sessionCookieName } from "@/lib/sign/tokens";

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return publicLink(
    request,
    params,
    async ({ ctx, lookup, ip, device }) => {
      if (!lookup.doc.code_required) throw new SignError("code_not_needed", "This document does not need a code.", 400);
      // A second limit that holds across processes, per person, on top of the five tries the database counts.
      if (!(await sharedLimit(`sign:verify:${lookup.signer.id}`, 30, 3600_000))) throw new SignError("code_rate_limited", "Too many tries. Try again in a while.", 429);
      const body = await readJson<{ code?: unknown }>(request, 2000);
      const entered = typeof body.code === "string" ? body.code.replace(/\s+/g, "") : "";
      if (!/^\d{6}$/.test(entered)) throw new SignError("code_format", "Enter the six digits from the email.", 400);
      const result = await verifyCode(ctx, lookup, entered, ip, device);
      if (!result.ok) {
        const status = result.reason === "wrong" ? 400 : 409;
        return NextResponse.json({ error: "That code did not work.", code: `code_${result.reason}`, attemptsLeft: result.attemptsLeft }, { status, headers: { "Cache-Control": "no-store" } });
      }
      const session = createSession(lookup.signer.id);
      if (!session) return failure(new SignError("session_unavailable", "Signing is not available right now.", 503));
      const res = json({ verified: true });
      res.headers.append("Set-Cookie", sessionCookie(sessionCookieName(lookup.signer.id), session.value, session.maxAgeSeconds));
      return res;
    },
    { rate: { limit: 30, windowMs: 60_000 } },
  );
}
