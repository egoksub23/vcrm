// ============================================================
// GET  /api/platform/encryption — how are stored secrets encrypted?
// POST /api/platform/encryption — re-encrypt every stale secret under the
//                                  current key (one time-boxed pass).
//
// Operator only. Cross-workspace by nature (it covers every workspace's
// channel tokens), so it runs on the service role behind
// requirePlatformAdmin and returns counts and key ids only: never a key,
// never a stored value. See docs/encryption-key-rotation.md.
// ============================================================
import { NextResponse } from "next/server";

import { toErrorResponse } from "@/lib/auth/account";
import { EncryptionConfigError } from "@/lib/crypto/keyring";
import { encryptionReport, reencryptAll } from "@/lib/crypto/reencrypt";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { requirePlatformAdmin } from "@/lib/platform/auth";
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from "@/lib/rate-limit";

const NO_STORE = { "Cache-Control": "no-store" };

function misconfigured(err: unknown): NextResponse | null {
  if (!(err instanceof EncryptionConfigError)) return null;
  return NextResponse.json({ error: err.message, code: "encryption_misconfigured" }, { status: 500, headers: NO_STORE });
}

export async function GET() {
  try {
    await requirePlatformAdmin();
    const report = await encryptionReport(supabaseAdmin());
    return NextResponse.json(report, { headers: NO_STORE });
  } catch (err) {
    const bad = misconfigured(err);
    if (bad) return bad;
    console.error("[GET /api/platform/encryption]", err);
    return toErrorResponse(err);
  }
}

export async function POST() {
  try {
    const { userId } = await requirePlatformAdmin();
    const limit = checkRateLimit(`platform-reencrypt:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const result = await reencryptAll(supabaseAdmin());
    console.info(
      `[platform] re-encrypt by ${userId}: rewritten=${result.rewritten} unreadable=${result.unreadable} conflicts=${result.conflicts} finished=${result.finished}`,
    );
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (err) {
    const bad = misconfigured(err);
    if (bad) return bad;
    console.error("[POST /api/platform/encryption]", err);
    return toErrorResponse(err);
  }
}
