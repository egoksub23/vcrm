// ============================================================
// Typed Jira errors. Routes map them to a status and a stable code the UI
// turns into a sentence; the queue decides retry versus dead-letter from
// `retryable`. None of them ever carries a token.
// ============================================================

export type JiraErrorCode =
  | "auth"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "validation"
  | "server"
  | "network"
  | "config"
  | "unknown";

export class JiraError extends Error {
  readonly code: JiraErrorCode;
  readonly status: number | null;
  constructor(message: string, code: JiraErrorCode = "unknown", status: number | null = null) {
    super(message);
    this.name = "JiraError";
    this.code = code;
    this.status = status;
  }
  /** Worth trying again later (the queue backs off). */
  get retryable(): boolean {
    return this.code === "rate_limit" || this.code === "server" || this.code === "network";
  }
}

/** 401, or a refresh token Atlassian no longer accepts: the user must reconnect. */
export class JiraAuthError extends JiraError {
  constructor(message = "Jira did not accept the connection", status: number | null = 401) {
    super(message, "auth", status);
    this.name = "JiraAuthError";
  }
}

/** 403: the connecting user may not do this (browse, create, transition ...). */
export class JiraPermissionError extends JiraError {
  constructor(message = "Jira says this is not allowed for the connected user") {
    super(message, "permission", 403);
    this.name = "JiraPermissionError";
  }
}

/** 404 / 410: the issue (or project, comment) is gone or not visible. */
export class JiraNotFoundError extends JiraError {
  constructor(message = "Jira could not find that") {
    super(message, "not_found", 404);
    this.name = "JiraNotFoundError";
  }
}

/** 429 (or 503 with Retry-After) after the client's own retries. */
export class JiraRateLimitError extends JiraError {
  readonly retryAfterMs: number;
  /** The shared quota of the whole Vircle app is exhausted, not just this workspace. */
  readonly global: boolean;
  readonly reason: string | null;
  constructor(retryAfterMs: number, opts: { global?: boolean; reason?: string | null } = {}) {
    super("Jira is rate limiting requests", "rate_limit", 429);
    this.name = "JiraRateLimitError";
    this.retryAfterMs = retryAfterMs;
    this.global = opts.global ?? false;
    this.reason = opts.reason ?? null;
  }
}

/** 400: Jira rejected the request; `fieldErrors` maps a field id to its message. */
export class JiraValidationError extends JiraError {
  readonly messages: string[];
  readonly fieldErrors: Record<string, string>;
  constructor(messages: string[], fieldErrors: Record<string, string> = {}) {
    super(messages[0] ?? Object.values(fieldErrors)[0] ?? "Jira rejected the request", "validation", 400);
    this.name = "JiraValidationError";
    this.messages = messages;
    this.fieldErrors = fieldErrors;
  }
}

/** 5xx / timeouts after retries. */
export class JiraServerError extends JiraError {
  constructor(message = "Jira is unavailable", status: number | null = 503) {
    super(message, "server", status);
    this.name = "JiraServerError";
  }
}

export class JiraNetworkError extends JiraError {
  constructor(message = "Could not reach Jira") {
    super(message, "network");
    this.name = "JiraNetworkError";
  }
}

/** Missing env var, bad cloud id, a request the client refuses to make. */
export class JiraConfigError extends JiraError {
  constructor(message: string) {
    super(message, "config");
    this.name = "JiraConfigError";
  }
}

export function isJiraError(e: unknown): e is JiraError {
  return e instanceof JiraError;
}

/** A short, token-free description for logs and diagnostics. */
export function describeError(e: unknown): string {
  if (e instanceof JiraError) return `${e.code}${e.status ? ` ${e.status}` : ""}: ${e.message}`.slice(0, 300);
  if (e instanceof Error) return e.message.slice(0, 300);
  return "unknown error";
}
