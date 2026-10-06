// ============================================================
// The HTTP edge of Doc Sign: what every route does the same way, so each route file is only what is
// particular to it.
//
//   staff   requireCapability, a rate limit per person, a service context for the workspace
//   public  no login: a link token, a rate limit per caller address, the signer's session cookie
//
// Errors become JSON `{ error, code, issues? }` with the status the service chose. Nothing the database
// said is passed through.
// ============================================================

import { NextResponse } from "next/server";

import { requireCapability, toErrorResponse, type CapabilityContext } from "@/lib/auth/account";
import { supabaseAdmin } from "@/lib/flows/admin-client";
import { clientIp } from "@/lib/net/client-ip";
import { bytesForChars, readBodyCapped } from "@/lib/net/read-capped";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { checkSharedRateLimit } from "@/lib/rate-limit-shared";
import { publicOrigin } from "@/lib/site-url";

import { signEnabled } from "./feature";
import { realDeps } from "./notify";
import { SignError } from "./service/errors";
import type { SignCtx } from "./service/context";
import { codeRequiredFor, lookupByToken, pickDocument, signerCtx, type Lookup } from "./service/signing";
import { isPlausibleToken, sessionCookieName, verifySession } from "./tokens";

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const NO_STORE = { "Cache-Control": "no-store" };

export function originOf(request: Request): string {
  return publicOrigin() || new URL(request.url).origin;
}

export function failure(err: unknown): NextResponse {
  if (err instanceof SignError) {
    return NextResponse.json({ error: err.message, code: err.code, ...(err.issues ? { issues: err.issues } : {}) }, { status: err.status, headers: NO_STORE });
  }
  // sign-in, permission and rate-limit errors keep the app's usual shape
  return toErrorResponse(err);
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** Parse a small JSON body, or answer 400. */
export async function readJson<T = Record<string, unknown>>(request: Request, maxBytes = 1_500_000): Promise<T> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new SignError("body_too_large", "That request is too large.", 413);
  // read a piece at a time and stop at the cap: a body sent chunked, or one that lies about its length, never fills the server's memory
  const raw = await readBodyCapped(request, bytesForChars(maxBytes));
  if (raw === null) throw new SignError("body_too_large", "That request is too large.", 413);
  const text = new TextDecoder().decode(raw);
  if (text.length > maxBytes) throw new SignError("body_too_large", "That request is too large.", 413);
  try {
    const v = JSON.parse(text || "{}");
    if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("not an object");
    return v as T;
  } catch {
    throw new SignError("bad_json", "The request body is not valid.", 400);
  }
}

// ---- staff -----------------------------------------------------------------------------------

export interface StaffCall {
  ctx: SignCtx;
  auth: CapabilityContext;
}

/** Run a staff route: capability, rate limit, context. */
export async function staff(
  capability: string,
  request: Request,
  handler: (call: StaffCall) => Promise<NextResponse>,
  opts: { rate?: { limit: number; windowMs: number } } = {},
): Promise<NextResponse> {
  try {
    const auth = await requireCapability(capability);
    const rate = checkRateLimit(`sign-staff:${auth.userId}:${capability}`, opts.rate ?? { limit: 120, windowMs: 60_000 });
    if (!rate.success) return rateLimitResponse(rate);
    const ctx: SignCtx = { admin: supabaseAdmin(), accountId: auth.accountId, userId: auth.userId, origin: originOf(request), deps: realDeps, now: () => new Date() };
    return await handler({ ctx, auth });
  } catch (err) {
    return failure(err);
  }
}

// ---- the signer's link ------------------------------------------------------------------------

export interface PublicCall {
  ctx: SignCtx;
  lookup: Lookup;
  /** The signer entered the code (or the document needs none). */
  sessionOk: boolean;
  ip: string | null;
  device: string | null;
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function sessionCookie(name: string, value: string, maxAgeSeconds: number): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure}`;
}

/** Shared limiter for the places that must hold across processes (codes). */
export const sharedLimit = async (key: string, limit: number, windowMs: number): Promise<boolean> => (await checkSharedRateLimit(key, { limit, windowMs })).success;

/**
 * Run a route a signer reaches with the token in the address. A token that is not a live link answers
 * 404 and nothing else: the answer never says whether a document exists.
 *
 * An envelope's link (migration 171) serves every document of the person: `?doc=<document id>` makes the route act on the person's own
 * row on that document. A document the person is not a signer of, a document id on a link that is not an envelope's, and anything that
 * is not an id all answer the same 404 as a bad link. The code's session belongs to the link itself, so one code opens every document.
 */
export async function publicLink(
  request: Request,
  params: Promise<{ token: string }>,
  handler: (call: PublicCall) => Promise<NextResponse>,
  opts: { rate?: { limit: number; windowMs: number } } = {},
): Promise<NextResponse> {
  try {
    const ip = clientIp(request.headers);
    const rate = checkRateLimit(`sign-public:${ip}`, opts.rate ?? { limit: 120, windowMs: 60_000 });
    if (!rate.success) return rateLimitResponse(rate);
    const { token } = await params;
    if (!isPlausibleToken(token)) return json({ error: "This link is not valid.", code: "link_not_found" }, 404);
    const admin = supabaseAdmin();
    const own = await lookupByToken(admin, token);
    // A workspace whose Doc Sign is switched off (or that is suspended) shows no document at all.
    if (!own || !(await signEnabled(admin, own.signer.account_id))) return json({ error: "This link is not valid.", code: "link_not_found" }, 404);
    let lookup = own;
    const wanted = new URL(request.url).searchParams.get("doc");
    if (wanted !== null) {
      const picked = UUID_RE.test(wanted) ? pickDocument(own, wanted) : null;
      if (!picked) return json({ error: "This link is not valid.", code: "link_not_found" }, 404);
      lookup = picked;
    }
    const ctx = signerCtx({ admin, origin: originOf(request), deps: realDeps, now: () => new Date() }, lookup);
    const sessionOk = !codeRequiredFor(own) || verifySession(readCookie(request.headers.get("cookie"), sessionCookieName(own.tokenSigner.id)), own.tokenSigner.id);
    const device = (request.headers.get("user-agent") ?? "").slice(0, 300) || null;
    return await handler({ ctx, lookup, sessionOk, ip: ip === "unknown" ? null : ip, device });
  } catch (err) {
    return failure(err);
  }
}

// ---- uploads -----------------------------------------------------------------------------------

export const MAX_UPLOAD_BODY = 26 * 1024 * 1024 + 256 * 1024;

/**
 * Read a multipart upload: one file and its text fields. Refuses a body that is too large before reading it.
 * A caller that has its own, tighter limit (a signer's upload) passes `maxBytes`.
 */
export async function readUpload(request: Request, maxBytes: number = MAX_UPLOAD_BODY): Promise<{ file: { bytes: Uint8Array; name: string } | null; fields: Record<string, string> }> {
  const declared = Number(request.headers.get("content-length"));
  const limitMb = Math.round(maxBytes / (1024 * 1024));
  if (Number.isFinite(declared) && declared > maxBytes) throw new SignError("upload_too_large", `This file is larger than ${maxBytes === MAX_UPLOAD_BODY ? 25 : limitMb} MB.`, 413);
  // the same cap on what is actually received, whatever the request declared
  const raw = await readBodyCapped(request, maxBytes);
  if (raw === null) throw new SignError("upload_too_large", `This file is larger than ${maxBytes === MAX_UPLOAD_BODY ? 25 : limitMb} MB.`, 413);
  const form = await new Response(raw as unknown as BodyInit, { headers: { "content-type": request.headers.get("content-type") ?? "" } }).formData().catch(() => null);
  if (!form) throw new SignError("bad_upload", "The upload could not be read.", 400);
  const fields: Record<string, string> = {};
  let file: { bytes: Uint8Array; name: string } | null = null;
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") fields[k] = v;
    else if (k === "file") file = { bytes: new Uint8Array(await v.arrayBuffer()), name: v.name || "document" };
  }
  return { file, fields };
}

export const optionalId = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v : null);
