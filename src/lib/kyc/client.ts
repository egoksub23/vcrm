// ============================================================
// KYC review: the calls to the doc-processor back end. Server only.
//
//   GET {base}/health                         no key; tells "service down" from "key rejected"
//   GET {base}/validations?friend_id=&limit=&before_id=  x-api-key; friend_id is optional (without it: the latest of everybody); before_id pages back
//   GET {base}/validations/{id}/url           x-api-key; a signed URL for the stored image (JSON, plain text or a redirect)
//   POST {base}/validations/{id}/review       x-api-key; {decision: "approve"|"reject", note}: records the decision, sets the child's eKYC status and, on a
//                                             rejection, e-mails the parent. The ONLY call that changes anything.
//   (POST /check belongs to the mobile app and is never called from Halo.)
//
// Rules this module keeps:
//   * the key is sent ONLY to the back end, in a header; never to the image host, never in a URL, never in a message
//   * every call has a deadline (10 s by default) covering the body as well as the headers
//   * a redirect is never followed: for the signed-URL call its Location is READ (and then goes through the SSRF guard); anywhere else it is an error
//   * the body of any answer is read through a size cap
//   * an error carries a CODE only (KycError); nothing the back end said, and no underlying error text, is kept or passed on
//   * every fetch is injected (`KycTransport`), so tests never touch the network
// ============================================================

import { readBodyCapped } from "@/lib/net/read-capped";

import { extractSignedUrl, isObject, toIso } from "./adapter";
import { type KycConfig } from "./config";
import { checkImageUrl } from "./ssrf";
import type { KycDecision, KycErrorCode } from "./types";

export type KycFetch = (url: string, init: RequestInit) => Promise<Response>;

/** The two fetches: one for the back end's API, one for the image host (production: a connection that re-checks the address it really uses). */
export interface KycTransport {
  api: KycFetch;
  image: KycFetch;
}

export const API_TIMEOUT_MS = 10_000;
export const IMAGE_TIMEOUT_MS = 10_000;
/** A review writes in two databases and may send an e-mail: it gets longer than a read. */
export const REVIEW_TIMEOUT_MS = 25_000;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_URL_BODY_BYTES = 64 * 1024;

export class KycError extends Error {
  readonly code: KycErrorCode;
  /**
   * For the SERVER LOG only, never sent to a browser: why a signed URL was refused and for which host ("host_not_allowed:files.example.com"),
   * so an administrator can fix KYC_DOC_ALLOWED_IMAGE_HOSTS. A host name only: no path, no query (the query of a signed URL is a credential).
   */
  readonly hint?: string;
  constructor(code: KycErrorCode, hint?: string) {
    // The message is the code: nothing from the back end, the network or the key ever ends up here.
    super(code);
    this.name = "KycError";
    this.code = code;
    this.hint = hint;
  }
}

export interface CallOptions {
  timeoutMs?: number;
}

/** Run `work` with a deadline. The abort signal lets a real fetch stop; the race makes the deadline hold even for a fetch that ignores it. */
async function withDeadline<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new KycError("upstream_unreachable"));
    }, ms);
  });
  try {
    return await Promise.race([work(ctl.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Anything thrown while talking to the back end becomes a code. A KycError passes through; every other error is "unreachable" and its text is dropped. */
function asKycError(err: unknown): KycError {
  return err instanceof KycError ? err : new KycError("upstream_unreachable");
}

function statusToError(status: number): KycError {
  if (status === 401 || status === 403) return new KycError("upstream_unauthorized");
  if (status === 404 || status === 410) return new KycError("not_found");
  if (status === 408 || status === 425 || status === 429 || status >= 500) return new KycError("upstream_unreachable");
  return new KycError("bad_response");
}

async function readText(res: Response, maxBytes: number): Promise<string> {
  const bytes = await readBodyCapped(res as unknown as { body: ReadableStream<Uint8Array> | null }, maxBytes);
  if (bytes === null) throw new KycError("bad_response");
  return new TextDecoder().decode(bytes);
}

function apiHeaders(config: KycConfig): HeadersInit {
  return { "x-api-key": config.apiKey, Accept: "application/json", "Cache-Control": "no-store" };
}

/** GET /health. True when the service answers 2xx; false for anything else, including no answer. Sends no key. */
export async function checkHealth(config: KycConfig, transport: KycTransport, opts: CallOptions = {}): Promise<boolean> {
  try {
    return await withDeadline(opts.timeoutMs ?? API_TIMEOUT_MS, async (signal) => {
      const res = await transport.api(`${config.baseUrl}/health`, { method: "GET", redirect: "manual", signal, headers: { Accept: "application/json" } });
      await res.body?.cancel().catch(() => undefined);
      return res.status >= 200 && res.status < 300;
    });
  } catch {
    return false;
  }
}

/** GET /validations?friend_id=&limit=&before_id=. An empty friend id leaves the filter out (the latest of everybody). Returns the parsed JSON, unread by the adapter yet. */
export async function fetchValidations(config: KycConfig, transport: KycTransport, friendId: string, limit: number, opts: CallOptions & { beforeId?: string | null } = {}): Promise<unknown> {
  const params: string[] = [];
  if (friendId) params.push(`friend_id=${encodeURIComponent(friendId)}`);
  params.push(`limit=${Math.max(1, Math.min(100, Math.trunc(limit)))}`);
  if (opts.beforeId) params.push(`before_id=${encodeURIComponent(opts.beforeId)}`);
  const url = `${config.baseUrl}/validations?${params.join("&")}`;
  try {
    return await withDeadline(opts.timeoutMs ?? API_TIMEOUT_MS, async (signal) => {
      const res = await transport.api(url, { method: "GET", redirect: "manual", signal, headers: apiHeaders(config) });
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel().catch(() => undefined);
        throw statusToError(res.status);
      }
      const text = await readText(res, MAX_JSON_BYTES);
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new KycError("bad_response");
      }
    });
  } catch (err) {
    throw asKycError(err);
  }
}

/**
 * GET /validations/{id}/url, then the guard. Returns the URL to fetch the image from (already checked: https, a public DNS name, the back end's
 * own domain or an allowed host). The id must already match VALIDATION_ID_RE (the route checks); it is percent-encoded here as well.
 */
export async function fetchSignedImageUrl(config: KycConfig, transport: KycTransport, validationId: string, opts: CallOptions = {}): Promise<URL> {
  const url = `${config.baseUrl}/validations/${encodeURIComponent(validationId)}/url`;
  let found: string | null;
  try {
    found = await withDeadline(opts.timeoutMs ?? API_TIMEOUT_MS, async (signal) => {
      const res = await transport.api(url, { method: "GET", redirect: "manual", signal, headers: apiHeaders(config) });
      const redirect = res.status >= 300 && res.status < 400;
      if (!redirect && (res.status < 200 || res.status >= 300)) {
        await res.body?.cancel().catch(() => undefined);
        throw statusToError(res.status);
      }
      const bodyText = redirect ? "" : await readText(res, MAX_URL_BODY_BYTES);
      if (redirect) await res.body?.cancel().catch(() => undefined);
      return extractSignedUrl({ status: res.status, location: res.headers.get("location"), bodyText });
    });
  } catch (err) {
    throw asKycError(err);
  }
  if (!found) throw new KycError("bad_response");

  // A relative Location is resolved against the back end; the guard then judges the result.
  let absolute = found;
  try {
    absolute = new URL(found, `${config.baseUrl}/`).toString();
  } catch {
    throw new KycError("bad_response");
  }
  const checked = checkImageUrl(absolute, config.baseHost, config.allowedImageHosts);
  if (!checked.ok) {
    let host = "";
    try {
      host = new URL(absolute).hostname;
    } catch {
      // unreadable: no host in the hint
    }
    throw new KycError("image_host_blocked", `${checked.reason}:${host}`);
  }
  return checked.url;
}

/** What the back end said about a decision, reduced to what the screen may be told. */
export interface ReviewReply {
  /** "APPROVED" / "REJECTED" as the back end wrote it, or null when it did not say. */
  reviewStatus: string | null;
  reviewedAt: string | null;
  /** The back end reported that it could not save the decision in one of the places it keeps it. */
  partial: boolean;
  /** The e-mail to the parent: sent, not sent, or not mentioned. */
  emailSent: boolean | null;
}

/**
 * POST /validations/{id}/review. The id must already match VALIDATION_ID_RE (the route checks); it is percent-encoded here as well. Any 2xx means the
 * decision was taken, even when the answer cannot be read. Never retried: a retry could e-mail a parent twice.
 */
export async function postReview(config: KycConfig, transport: KycTransport, validationId: string, decision: KycDecision, note: string, opts: CallOptions = {}): Promise<ReviewReply> {
  const url = `${config.baseUrl}/validations/${encodeURIComponent(validationId)}/review`;
  const body = JSON.stringify(note ? { decision, note } : { decision });
  try {
    return await withDeadline(opts.timeoutMs ?? REVIEW_TIMEOUT_MS, async (signal) => {
      const res = await transport.api(url, { method: "POST", redirect: "manual", signal, headers: { ...apiHeaders(config), "Content-Type": "application/json" }, body });
      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel().catch(() => undefined);
        // 409: somebody decided first. 400 and 422: the back end did not accept what we sent (a programming error here, never the reviewer's).
        if (res.status === 409) throw new KycError("already_decided");
        if (res.status === 400 || res.status === 422) throw new KycError("invalid_request");
        throw statusToError(res.status);
      }
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(await readText(res, MAX_JSON_BYTES)) as unknown;
      } catch {
        // taken, but unreadable: the reply is all unknowns
      }
      return readReviewReply(parsed);
    });
  } catch (err) {
    throw asKycError(err);
  }
}

function readReviewReply(body: unknown): ReviewReply {
  if (!isObject(body)) return { reviewStatus: null, reviewedAt: null, partial: false, emailSent: null };
  const status = typeof body.review_status === "string" ? body.review_status.replace(/[^A-Za-z0-9_ -]/g, "").trim().slice(0, 30) : "";
  const at = typeof body.reviewed_at === "string" || typeof body.reviewed_at === "number" ? toIso(body.reviewed_at) : null;
  const stored = [body.postgres, body.dynamodb].some((p) => isObject(p) && p.ok === false);
  const email = isObject(body.email) && typeof body.email.ok === "boolean" ? body.email.ok : null;
  return { reviewStatus: status || null, reviewedAt: at, partial: stored, emailSent: email };
}

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];

/** The type the first bytes say it is (a header can lie), or null. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return null;
}

export interface FetchedImage {
  bytes: Uint8Array;
  contentType: ImageType;
}

/**
 * Fetch the image from the (already guarded) signed URL. No key is sent. A redirect is not followed. The answer must be 200, declare an allowed image
 * type (JPEG, PNG or WebP; a PDF is refused on purpose: it can carry active content), not exceed the size cap (declared or actual) and START with the
 * bytes of that type.
 */
export async function fetchImage(transport: KycTransport, url: URL, opts: CallOptions & { maxBytes?: number } = {}): Promise<FetchedImage> {
  const maxBytes = opts.maxBytes ?? MAX_IMAGE_BYTES;
  try {
    return await withDeadline(opts.timeoutMs ?? IMAGE_TIMEOUT_MS, async (signal) => {
      const res = await transport.image(url.toString(), { method: "GET", redirect: "manual", signal, headers: { Accept: "image/jpeg,image/png,image/webp" } });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        throw res.status === 404 || res.status === 403 ? new KycError("not_found") : new KycError("bad_response");
      }
      const declaredType = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!(IMAGE_TYPES as readonly string[]).includes(declaredType)) {
        await res.body?.cancel().catch(() => undefined);
        throw new KycError("image_type_unsupported");
      }
      const declared = Number(res.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new KycError("image_too_large");
      }
      const bytes = await readBodyCapped(res as unknown as { body: ReadableStream<Uint8Array> | null }, maxBytes);
      if (bytes === null) throw new KycError("image_too_large");
      const sniffed = sniffImageType(bytes);
      if (!sniffed) throw new KycError("image_type_unsupported");
      // Serve what the bytes ARE, which may differ from the header only between the allowed image types.
      return { bytes, contentType: sniffed };
    });
  } catch (err) {
    throw asKycError(err);
  }
}
