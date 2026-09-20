// Server-side helpers for the approvals routes. Server-only (NextResponse).

import { NextResponse } from "next/server";

import { approvalErrorCode, approvalErrorStatus } from "./rules";

/**
 * Turn an error from one of the approval RPCs into the JSON error the
 * screens understand: `{ error, code }` where `code` selects an
 * `Approvals.errors.*` string. Permission errors keep the database's own
 * message; nothing internal leaks for an unknown failure.
 */
export function approvalErrorResponse(
  err: { message?: string | null; code?: string | null },
): NextResponse {
  const code = approvalErrorCode(err);
  if (code === "unknown") {
    console.error("[approvals] rpc error:", err);
    return NextResponse.json({ error: "Something went wrong", code }, { status: 500 });
  }
  const message = code === "forbidden" && err.message ? err.message : code;
  return NextResponse.json({ error: message, code }, { status: approvalErrorStatus(code) });
}
