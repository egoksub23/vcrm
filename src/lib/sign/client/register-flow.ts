// ============================================================
// Doc Sign, registration page (/r/<slug>): the logic of the form that has no screen in it. Pure, so it is
// tested without a browser:
//   - `precheck`: what a person can be told at once, before anything is sent (the server checks all of it again
//     and is the authority; this only saves a round trip for an empty or plainly wrong field);
//   - `readAnswer`: what the route's answer means for the screen.
// Nothing here may import a server module: it runs in the browser.
// ============================================================

import type { AskedFields } from "@/lib/sign/registration/types";

export type Detail = "full_name" | "email" | "phone" | "company" | "consent";
export type Problem = "required" | "too_long" | "invalid";
export type Problems = Partial<Record<Detail, Problem>>;

/** The order the page shows (and focuses) its fields in. */
export const DETAIL_ORDER: readonly Detail[] = ["full_name", "company", "email", "phone", "consent"];

export interface Values {
  fullName: string;
  company: string;
  email: string;
  phone: string;
  consent: boolean;
}

export const EMPTY_VALUES: Values = { fullName: "", company: "", email: "", phone: "", consent: false };

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIMITS = { full_name: 120, company: 160, email: 254, phone: 32 } as const;

/** What can be said before sending. An empty result means "send it". */
export function precheck(values: Values, asked: AskedFields): Problems {
  const out: Problems = {};
  const text = (detail: "full_name" | "company", raw: string) => {
    if (asked[detail] === "off") return;
    const v = clean(raw);
    if (!v) {
      if (asked[detail] === "required") out[detail] = "required";
    } else if (v.length > LIMITS[detail]) out[detail] = "too_long";
    else if (/[<>]/.test(v)) out[detail] = "invalid";
  };
  text("full_name", values.fullName);
  text("company", values.company);

  const email = clean(values.email);
  if (!email) out.email = "required";
  else if (email.length > LIMITS.email) out.email = "too_long";
  else if (!EMAIL.test(email) || /[<>]/.test(email)) out.email = "invalid";

  if (asked.phone !== "off") {
    const phone = clean(values.phone);
    const digits = phone.replace(/\D/g, "");
    if (!phone) {
      if (asked.phone === "required") out.phone = "required";
    } else if (phone.length > LIMITS.phone) out.phone = "too_long";
    else if (!/^[1-9]\d{6,14}$/.test(digits)) out.phone = "invalid";
  }
  if (!values.consent) out.consent = "required";
  return out;
}

/** The first of the page's fields that has a problem, for the focus. */
export const firstProblem = (problems: Problems): Detail | null => DETAIL_ORDER.find((d) => problems[d]) ?? null;

// ---- the route's answer --------------------------------------------------------------------------------

/** A reason the whole form is replaced by a notice (nothing more can be done here) or shown above it (try again). */
export type NoticeCode = "rate_limited" | "form_cap" | "send_failed" | "try_later" | "unavailable" | "not_found" | "generic" | "network";
export type RetryCode = "token_invalid" | "token_expired" | "token_too_fast" | "captcha_failed";

export type Answer =
  | { kind: "ok" }
  | { kind: "problems"; problems: Problems }
  | { kind: "retry"; code: RetryCode; token: string | null }
  | { kind: "notice"; code: NoticeCode };

/** These end the visit: the form is replaced. The others leave the form in place with a message above it. */
export const FINAL_NOTICES: readonly NoticeCode[] = ["form_cap", "send_failed", "unavailable", "not_found"];

const RETRY_CODES: readonly string[] = ["token_invalid", "token_expired", "token_too_fast", "captcha_failed"];
const NOTICE_CODES: readonly string[] = ["rate_limited", "form_cap", "send_failed", "try_later", "unavailable", "not_found"];
const PROBLEMS: readonly string[] = ["required", "too_long", "invalid"];

/** What a response means. `body` is the parsed JSON, or null when there was none. */
export function readAnswer(status: number, body: unknown): Answer {
  const b = (typeof body === "object" && body !== null ? body : {}) as { ok?: unknown; code?: unknown; token?: unknown; problems?: unknown };
  if (status === 200 && b.ok === true) return { kind: "ok" };
  const code = typeof b.code === "string" ? b.code : "";
  if (code === "invalid" && typeof b.problems === "object" && b.problems !== null) {
    const problems: Problems = {};
    for (const [k, v] of Object.entries(b.problems as Record<string, unknown>)) {
      if ((DETAIL_ORDER as readonly string[]).includes(k) && typeof v === "string" && PROBLEMS.includes(v)) problems[k as Detail] = v as Problem;
    }
    return Object.keys(problems).length > 0 ? { kind: "problems", problems } : { kind: "notice", code: "generic" };
  }
  if (RETRY_CODES.includes(code)) return { kind: "retry", code: code as RetryCode, token: typeof b.token === "string" && b.token ? b.token : null };
  if (NOTICE_CODES.includes(code)) return { kind: "notice", code: code as NoticeCode };
  return { kind: "notice", code: status === 429 ? "rate_limited" : "generic" };
}
