// ============================================================
// Doc Sign, browser side: one way to call the Doc Sign routes and to read their failures.
//
// Every route answers errors as `{ error, code, issues? }`. The screens word the `code` in the reader's
// language (the `error` text is English and only for logs), so a failure arrives here as a SignApiError
// carrying the code, the HTTP status and, for a layout that is not sound or a document that cannot be
// sent yet, the list of issues (each a code with the field, role or position it is about).
// ============================================================

import { publicPath } from "./scope";

export interface SignIssue {
  code: string;
  field?: string;
  role?: string;
  /** Envelopes: the document of the envelope the problem is about. */
  document?: string;
  detail?: string;
}

export class SignApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues: SignIssue[];
  /** Present on a wrong code: how many tries are left. */
  readonly attemptsLeft?: number;

  constructor(code: string, message: string, status: number, issues: SignIssue[] = [], attemptsLeft?: number) {
    super(message);
    this.name = "SignApiError";
    this.code = code;
    this.status = status;
    this.issues = issues;
    this.attemptsLeft = attemptsLeft;
  }
}

async function failureOf(res: Response): Promise<SignApiError> {
  let body: { error?: unknown; code?: unknown; issues?: unknown; attemptsLeft?: unknown; retryAfter?: unknown } = {};
  try {
    body = await res.json();
  } catch {
    // not JSON (a proxy's page, an empty body)
  }
  const code = typeof body.code === "string" ? body.code : res.status === 429 ? "rate_limited" : res.status === 401 ? "signed_out" : res.status === 403 ? "forbidden" : "request_failed";
  return new SignApiError(
    code,
    typeof body.error === "string" ? body.error : `Request failed (${res.status})`,
    res.status,
    Array.isArray(body.issues) ? (body.issues as SignIssue[]) : [],
    typeof body.attemptsLeft === "number" ? body.attemptsLeft : undefined,
  );
}

/** Call a route and return its JSON, or throw a SignApiError. A network failure is code "network". */
export async function signRequest<T = unknown>(path: string, init: { method?: string; json?: unknown; form?: FormData; signal?: AbortSignal } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.json !== undefined || init.form ? "POST" : "GET"),
      credentials: "same-origin",
      cache: "no-store",
      signal: init.signal,
      headers: init.json !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: init.form ?? (init.json !== undefined ? JSON.stringify(init.json) : undefined),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new SignApiError("network", "Could not reach the server.", 0);
  }
  if (!res.ok) throw await failureOf(res);
  return (await res.json()) as T;
}

/** The address of a document's file, for the viewer (`kind`: base, final or original). */
export const documentFileUrl = (documentId: string, kind: "base" | "final" | "original" = "base", download = false) =>
  `/api/sign/documents/${documentId}/file?kind=${kind}${download ? "&download=1" : ""}`;

export const templateFileUrl = (templateId: string) => `/api/sign/templates/${templateId}/file`;

/** The address of the file on a signer's link; `scope` is the token, or `<token>@<document id>` for one document of an envelope (see ./scope.ts). */
export const signerFileUrl = (scope: string, download = false) => publicPath(scope, "/file", { query: download ? "download=1" : "" });
