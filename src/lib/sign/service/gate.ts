// ============================================================
// Is Doc Sign switched on for the workspace a staff call is made in? The operator's flag `sign` (feature.ts) gates
// every route and job that is new in phase 2, so a workspace whose module is off can neither start a batch nor
// download anything through it.
// ============================================================

import { signEnabled } from "../feature";
import type { SignCtx } from "./context";
import { SignError } from "./errors";

export async function assertSignOn(ctx: Pick<SignCtx, "admin" | "accountId">): Promise<void> {
  if (!(await signEnabled(ctx.admin, ctx.accountId))) throw new SignError("sign_disabled", "Secure Sign is not switched on for this workspace.", 403);
}
