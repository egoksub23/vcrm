// ============================================================
// Watching the sealing certificate. A certificate a workspace uploaded ends on a known day; if nobody installs a
// new one in time, every document that finishes signing waits unsealed. So the workspace's administrators (the
// members who hold sign.settings, owner and admin by default) are told in Halo at 30, 14 and 7 days before it
// ends, and once more when it has ended: each warning once, however often the job runs. The last warning sent is
// kept on the certificate (sign_certificates.expiry_notified_days), claimed with a conditional update so two runs
// at the same moment cannot both send it.
//
// Only certificates the workspace uploaded are watched: the one Halo makes itself lasts five years and is renewed
// by the next seal without anyone being asked.
// ============================================================

import { loadCapabilityRecipients } from "@/lib/auth/capability-recipients";

import { signEnabled } from "../feature";
import type { SignCtx } from "./context";

type Base = Omit<SignCtx, "accountId" | "userId">;

/** Days before the end at which a warning goes out. 0 stands for "has ended". */
export const EXPIRY_THRESHOLDS = [30, 14, 7] as const;
export type ExpiryThreshold = (typeof EXPIRY_THRESHOLDS)[number] | 0;

const DAY_MS = 86_400_000;

/** The warning that applies today: 0 once ended, else the smallest of 30/14/7 that the days left fit under, else null. */
export function expiryThreshold(validUntil: Date, now: Date): ExpiryThreshold | null {
  const left = validUntil.getTime() - now.getTime();
  if (left <= 0) return 0;
  const days = Math.ceil(left / DAY_MS);
  const hit = [...EXPIRY_THRESHOLDS].reverse().find((t) => days <= t);
  return hit ?? null;
}

/** A warning is sent when there is one and it is a step closer to the end than the last one sent. */
export function shouldWarn(threshold: ExpiryThreshold | null, last: number | null | undefined): boolean {
  if (threshold === null) return false;
  return last === null || last === undefined || threshold < last;
}

export function warningText(threshold: ExpiryThreshold, validUntil: Date, subject: string | null): { title: string; body: string } {
  const date = validUntil.toISOString().slice(0, 10);
  const who = subject ? ` (${subject.split(",")[0].trim()})` : "";
  if (threshold === 0) {
    return {
      title: "Sealing certificate has expired",
      body: `The certificate that seals your signed documents${who} ended on ${date}. Documents that everyone has signed now wait, unsealed, until a valid certificate is installed in Settings > Doc Sign > Sealing certificate.`,
    };
  }
  return {
    title: `Sealing certificate ends in ${threshold} days`,
    body: `The certificate that seals your signed documents${who} is valid until ${date}. Install a renewed certificate in Settings > Doc Sign > Sealing certificate before then; after that day documents that everyone has signed wait, unsealed, until you do.`,
  };
}

interface Row {
  id: string;
  account_id: string;
  subject: string | null;
  valid_until: string | null;
  expiry_notified_days: number | null;
}

/** One pass: send each workspace's due warning. Never throws; returns how many certificates were looked at and warned about. */
export async function runCertificateWatch(base: Base, limit = 500): Promise<{ checked: number; notified: number }> {
  const now = base.now();
  const horizon = new Date(now.getTime() + (EXPIRY_THRESHOLDS[0] + 1) * DAY_MS).toISOString();
  const { data, error } = await base.admin
    .from("sign_certificates")
    .select("id, account_id, subject, valid_until, expiry_notified_days")
    .eq("source", "uploaded")
    .eq("is_default", true)
    .lte("valid_until", horizon)
    .limit(limit);
  if (error) {
    console.error("[sign] certificate watch failed:", error.message);
    return { checked: 0, notified: 0 };
  }
  const rows = (data ?? []) as Row[];
  let notified = 0;
  for (const r of rows) {
    try {
      if (!r.valid_until) continue;
      const validUntil = new Date(r.valid_until);
      const threshold = expiryThreshold(validUntil, now);
      if (!shouldWarn(threshold, r.expiry_notified_days) || threshold === null) continue;
      if (!(await signEnabled(base.admin, r.account_id))) continue;

      // claim this warning: only the run that moves the marker sends it
      const claim = base.admin.from("sign_certificates").update({ expiry_notified_days: threshold }).eq("id", r.id).eq("account_id", r.account_id);
      const { data: won } = await (r.expiry_notified_days === null ? claim.is("expiry_notified_days", null) : claim.eq("expiry_notified_days", r.expiry_notified_days)).select("id");
      if (!won || won.length === 0) continue;

      const recipients = await loadCapabilityRecipients(base.admin, r.account_id, "sign.settings", { roles: ["owner", "admin"] });
      // nobody to tell (every owner and admin lost the capability): the warning stays marked, there is nothing to retry
      if (recipients.length === 0) continue;
      const text = warningText(threshold, validUntil, r.subject);
      const ins = await base.admin.from("notifications").insert(recipients.map((userId) => ({ account_id: r.account_id, user_id: userId, type: "sign_certificate_expiring", title: text.title, body: text.body })));
      if (ins.error) {
        // not delivered: give the warning back so the next run tries again
        console.error("[sign] certificate warning not delivered for", r.id, ins.error.message);
        await base.admin.from("sign_certificates").update({ expiry_notified_days: r.expiry_notified_days }).eq("id", r.id).eq("account_id", r.account_id);
        continue;
      }
      notified++;
    } catch (err) {
      console.error("[sign] certificate warning failed for", r.id, err instanceof Error ? err.message : err);
    }
  }
  return { checked: rows.length, notified };
}
