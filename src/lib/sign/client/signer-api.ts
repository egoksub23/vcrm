// ============================================================
// Doc Sign, signing page: the calls the page makes, one function each. They go through `signRequest`,
// so a failure arrives as a SignApiError with a stable `code` (and `attemptsLeft` for a wrong code).
// The token is in the address; no login, and the code's session is a cookie only the server reads.
// ============================================================

import type { SigningView } from "../service/signing";
import type { AnswerInput } from "../rules";
import { SignApiError, signRequest } from "./api";
import type { SaveResponse } from "./signer-flow";

const base = (token: string) => `/api/sign/public/${token}`;

export const fetchView = (token: string, signal?: AbortSignal) => signRequest<SigningView>(base(token), { signal });

export const requestCode = (token: string) => signRequest<{ sent: true; to: string }>(`${base(token)}/code`, { method: "POST", json: {} });

export const verifyCode = (token: string, code: string) => signRequest<{ verified: true }>(`${base(token)}/code/verify`, { method: "POST", json: { code } });

export const giveConsent = (token: string, locale: string) => signRequest<{ consented: true }>(`${base(token)}/consent`, { method: "POST", json: { locale } });

export const saveAnswers = (token: string, answers: Record<string, AnswerInput>) => signRequest<SaveResponse>(`${base(token)}/answers`, { method: "PUT", json: { answers } });

export const completeSigning = (token: string, answers: Record<string, AnswerInput>, locale: string) =>
  signRequest<{ completed: true; sealing: boolean }>(`${base(token)}/complete`, { method: "POST", json: { answers, locale } });

export const declineSigning = (token: string, reason: string) => signRequest<{ declined: true }>(`${base(token)}/decline`, { method: "POST", json: { reason } });

/** Is this failure worth another try: no connection, a busy server (429) or a server in trouble (5xx)? */
export function isRetryableFailure(err: unknown): boolean {
  return err instanceof SignApiError && (err.code === "network" || err.status === 429 || err.status >= 500);
}

export const isOfflineFailure = (err: unknown): boolean => err instanceof SignApiError && err.code === "network";
