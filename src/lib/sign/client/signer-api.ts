// ============================================================
// Doc Sign, signing page: the calls the page makes, one function each. They go through `signRequest`,
// so a failure arrives as a SignApiError with a stable `code` (and `attemptsLeft` for a wrong code).
// The token is in the address; no login, and the code's session is a cookie only the server reads.
// ============================================================

import type { RemoveUploadResult, ReviewResult, UploadResult } from "../forms/api-types";
import type { DataAnswerInput } from "../forms/types";
import type { SigningView } from "../service/signing";
import type { AnswerInput } from "../rules";
import { SignApiError, signRequest, type SignIssue } from "./api";
import { publicPath } from "./scope";
import type { SaveResponse } from "./signer-flow";

// Every call takes the page's SCOPE: the link's token, or `<token>@<document id>` for one document of an envelope (see ./scope.ts). The
// code is about the whole link, so its calls never name a document.

export const fetchView = (token: string, signal?: AbortSignal) => signRequest<SigningView>(publicPath(token), { signal });

export const requestCode = (token: string) => signRequest<{ sent: true; to: string }>(publicPath(token, "/code", { withDocument: false }), { method: "POST", json: {} });

export const verifyCode = (token: string, code: string) => signRequest<{ verified: true }>(publicPath(token, "/code/verify", { withDocument: false }), { method: "POST", json: { code } });

export const giveConsent = (token: string, locale: string) => signRequest<{ consented: true }>(publicPath(token, "/consent"), { method: "POST", json: { locale } });

/** What a save carries: a value for a field on the page, or for a data field of a form. */
export type SavedInput = AnswerInput | DataAnswerInput;

export const saveAnswers = (token: string, answers: Record<string, SavedInput>, confirmParts: readonly string[] = []) =>
  signRequest<SaveResponse>(publicPath(token, "/answers"), { method: "PUT", json: confirmParts.length > 0 ? { answers, confirmParts } : { answers } });

/** The answers as they will be printed on the form, and any answer too long for its place. */
export const fetchReview = (token: string) => signRequest<ReviewResult>(publicPath(token, "/review"));

export const removeUpload = (token: string, field: string, id: string) =>
  signRequest<RemoveUploadResult>(publicPath(token, "/upload", { query: `field=${encodeURIComponent(field)}&id=${encodeURIComponent(id)}` }), { method: "DELETE" });

/** A failed answer's body (`{ error, code, issues }`) as the error the page words. Pure, for the upload, which cannot use `fetch` (it has no progress). */
export function failureFrom(status: number, text: string): SignApiError {
  let body: { error?: unknown; code?: unknown; issues?: unknown } = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") body = parsed as typeof body;
  } catch {
    // not JSON (a proxy's page, an empty body)
  }
  const code = typeof body.code === "string" ? body.code : status === 429 ? "rate_limited" : status === 413 ? "file_too_large" : status === 401 ? "signed_out" : status === 403 ? "forbidden" : "request_failed";
  return new SignApiError(code, typeof body.error === "string" ? body.error : `Request failed (${status})`, status, Array.isArray(body.issues) ? (body.issues as SignIssue[]) : []);
}

/**
 * Send a file for a data field, telling `onProgress` (0 to 1) as it goes. It uses XMLHttpRequest because
 * `fetch` cannot report how much of an upload has gone. A failure is a SignApiError, as everywhere else.
 */
export function uploadFile(token: string, field: string, file: File, onProgress?: (fraction: number) => void, signal?: AbortSignal): Promise<UploadResult> {
  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const done = () => signal?.removeEventListener("abort", abort);
    const abort = () => xhr.abort();
    xhr.open("POST", publicPath(token, "/upload"));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress?.(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as UploadResult);
        } catch {
          reject(new SignApiError("request_failed", "Unreadable answer.", xhr.status));
        }
      } else reject(failureFrom(xhr.status, xhr.responseText));
    };
    xhr.onerror = () => {
      done();
      reject(new SignApiError("network", "Could not reach the server.", 0));
    };
    xhr.onabort = () => {
      done();
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort);
    const body = new FormData();
    body.append("field", field);
    body.append("file", file, file.name);
    xhr.send(body);
  });
}

/**
 * Finish a document. With `check` the server applies every rule and changes nothing (an envelope's "next document": the document is only
 * checked, and signed with the others when the last one is finished).
 */
export const completeSigning = (token: string, answers: Record<string, AnswerInput>, locale: string, opts: { check?: boolean } = {}) =>
  signRequest<{ completed?: true; sealing?: boolean; checked?: true }>(publicPath(token, "/complete"), { method: "POST", json: opts.check ? { answers, locale, check: true } : { answers, locale } });

/** What finishing an envelope did: the documents it completed (in order), the ones still to do, and whether any is now being sealed. */
export interface EnvelopeFinishResponse {
  completed: string[];
  remaining: string[];
  sealing: boolean;
}

/** Finish an envelope: every document of the person that is still theirs, completed in order. A failure names its document on every issue. */
export const finishEnvelope = (token: string, locale: string) => signRequest<EnvelopeFinishResponse>(publicPath(token, "/envelope/finish", { withDocument: false }), { method: "POST", json: { locale } });

export const declineSigning = (token: string, reason: string) => signRequest<{ declined: true }>(publicPath(token, "/decline"), { method: "POST", json: { reason } });

/** What a forward answers: who it went to, whether the message reached them, and how many forwards are left. */
export interface ForwardResponse {
  scope: "turn" | "part";
  to: string;
  delivery: { channel: string; status: "sent" | "failed" | "not_configured"; detail?: string };
  remaining: number;
}

/** Hand the whole turn (no `part`) or one part of the form to someone else. */
export const forwardTo = (token: string, body: { fullName: string; email: string; note?: string; part?: string }) => signRequest<ForwardResponse>(publicPath(token, "/forward"), { method: "POST", json: body });

/** Take a part back from the person it was handed to, before they complete it. */
export const takeBackPart = (token: string, part: string) => signRequest<{ part: string; removed: boolean }>(publicPath(token, "/forward"), { method: "DELETE", json: { part } });

/** Is this failure worth another try: no connection, a busy server (429) or a server in trouble (5xx)? */
export function isRetryableFailure(err: unknown): boolean {
  return err instanceof SignApiError && (err.code === "network" || err.status === 429 || err.status >= 500);
}

export const isOfflineFailure = (err: unknown): boolean => err instanceof SignApiError && err.code === "network";
