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
import type { SaveResponse } from "./signer-flow";

const base = (token: string) => `/api/sign/public/${token}`;

export const fetchView = (token: string, signal?: AbortSignal) => signRequest<SigningView>(base(token), { signal });

export const requestCode = (token: string) => signRequest<{ sent: true; to: string }>(`${base(token)}/code`, { method: "POST", json: {} });

export const verifyCode = (token: string, code: string) => signRequest<{ verified: true }>(`${base(token)}/code/verify`, { method: "POST", json: { code } });

export const giveConsent = (token: string, locale: string) => signRequest<{ consented: true }>(`${base(token)}/consent`, { method: "POST", json: { locale } });

/** What a save carries: a value for a field on the page, or for a data field of a form. */
export type SavedInput = AnswerInput | DataAnswerInput;

export const saveAnswers = (token: string, answers: Record<string, SavedInput>, confirmParts: readonly string[] = []) =>
  signRequest<SaveResponse>(`${base(token)}/answers`, { method: "PUT", json: confirmParts.length > 0 ? { answers, confirmParts } : { answers } });

/** The answers as they will be printed on the form, and any answer too long for its place. */
export const fetchReview = (token: string) => signRequest<ReviewResult>(`${base(token)}/review`);

export const removeUpload = (token: string, field: string, id: string) =>
  signRequest<RemoveUploadResult>(`${base(token)}/upload?field=${encodeURIComponent(field)}&id=${encodeURIComponent(id)}`, { method: "DELETE" });

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
    xhr.open("POST", `${base(token)}/upload`);
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

export const completeSigning = (token: string, answers: Record<string, AnswerInput>, locale: string) =>
  signRequest<{ completed: true; sealing: boolean }>(`${base(token)}/complete`, { method: "POST", json: { answers, locale } });

export const declineSigning = (token: string, reason: string) => signRequest<{ declined: true }>(`${base(token)}/decline`, { method: "POST", json: { reason } });

/** Is this failure worth another try: no connection, a busy server (429) or a server in trouble (5xx)? */
export function isRetryableFailure(err: unknown): boolean {
  return err instanceof SignApiError && (err.code === "network" || err.status === 429 || err.status >= 500);
}

export const isOfflineFailure = (err: unknown): boolean => err instanceof SignApiError && err.code === "network";
