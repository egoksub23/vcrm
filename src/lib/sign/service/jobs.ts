// ============================================================
// The scheduled work of Doc Sign, run every minute by /api/sign/jobs-cron: seal documents that are
// fully signed, expire documents past their date, and send due reminders. Each part is bounded and
// fair: a small batch per run, oldest first, so one workspace's backlog cannot starve another's.
// ============================================================

import { dueReminders } from "../defaults";
import type { SignDocumentRow, SignSignerRow } from "../types";
import { loadSigners, type SignCtx } from "./context";
import { notifyExpired } from "./outcome";
import { remindSigner } from "./send";
import { runSealing } from "./seal";

type Base = Omit<SignCtx, "accountId" | "userId">;

export async function runExpiry(base: Base, limit = 50): Promise<{ expired: number }> {
  const { data, error } = await base.admin.rpc("sign_expire_due", { p_limit: limit });
  if (error) {
    console.error("[sign] expiry run failed:", error.message);
    return { expired: 0 };
  }
  const rows = (data ?? []) as { document_id: string; account_id: string }[];
  for (const r of rows) {
    const ctx: SignCtx = { ...base, accountId: r.account_id, userId: null };
    const doc = await base.admin.from("sign_documents").select("*").eq("id", r.document_id).eq("account_id", r.account_id).maybeSingle();
    if (!doc.data) continue;
    await notifyExpired(ctx, doc.data as SignDocumentRow, await loadSigners(ctx, r.document_id));
  }
  return { expired: rows.length };
}

export async function runReminders(base: Base, limit = 100): Promise<{ checked: number; reminded: number }> {
  const { data, error } = await base.admin
    .from("sign_signers")
    .select("*, doc:sign_documents!inner(id, account_id, status, reminder_days)")
    .in("status", ["sent", "viewed"])
    .not("invited_at", "is", null)
    .in("doc.status", ["sent", "in_progress"])
    .order("invited_at", { ascending: true })
    .limit(limit);
  if (error) {
    console.error("[sign] reminder run failed:", error.message);
    return { checked: 0, reminded: 0 };
  }
  const rows = (data ?? []) as (SignSignerRow & { doc: { id: string; account_id: string; reminder_days: number[] | null } })[];
  const now = base.now();
  let reminded = 0;
  for (const r of rows) {
    const due = dueReminders([r], r.doc.reminder_days ?? [], now);
    if (due.length === 0) continue;
    try {
      await remindSigner({ ...base, accountId: r.doc.account_id, userId: null }, r.doc.id, r.id);
      reminded++;
    } catch (err) {
      console.error("[sign] reminder failed for", r.id, err instanceof Error ? err.message : err);
    }
  }
  return { checked: rows.length, reminded };
}

export async function runAll(base: Base): Promise<Record<string, number>> {
  const seal = await runSealing(base, 2);
  const expiry = await runExpiry(base);
  const reminders = await runReminders(base);
  return { claimed: seal.claimed, sealed: seal.completed, seal_retry: seal.retry, expired: expiry.expired, reminders_checked: reminders.checked, reminded: reminders.reminded };
}
