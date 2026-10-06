// Shared plumbing for the Doc Sign services: the context every call carries, and the small reads
// nearly every operation starts with. Everything here runs with the service-role client, so each read is
// scoped to an account explicitly: a service never touches a row it did not check belongs to `accountId`.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { NotifyDeps } from "../notify";
import { SignError, raiseDatabaseError } from "./errors";
import type { SignDocumentRow, SignSettingsRow, SignSignerRow } from "../types";

export interface SignCtx {
  admin: SupabaseClient;
  accountId: string;
  /** The signed-in person acting, or null for the system (jobs) and for a signer. */
  userId: string | null;
  /** The address links are built on, for example https://halo.vircle.tech. */
  origin: string;
  deps: NotifyDeps;
  now: () => Date;
  /** How the call arrived when it was not a person at a screen, for example `api_key:<key id>`. Added to the events the services log. */
  via?: string;
  /** How many Doc Sign events deep an automation run is that made this call (loop guard, see outbound.ts). Absent for a person or a job. */
  chainDepth?: number;
}

export async function loadDocument(ctx: SignCtx, documentId: string): Promise<SignDocumentRow> {
  const { data, error } = await ctx.admin.from("sign_documents").select("*").eq("id", documentId).eq("account_id", ctx.accountId).maybeSingle();
  if (error) raiseDatabaseError(error, "load document");
  if (!data) throw new SignError("document_not_found", "That document was not found.", 404);
  return data as SignDocumentRow;
}

export async function loadSigners(ctx: SignCtx, documentId: string): Promise<SignSignerRow[]> {
  const { data, error } = await ctx.admin
    .from("sign_signers")
    .select("*")
    .eq("document_id", documentId)
    .eq("account_id", ctx.accountId)
    .order("order_no", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) raiseDatabaseError(error, "load signers");
  return (data ?? []) as SignSignerRow[];
}

/** The workspace's Doc Sign settings, created with the starting categories the first time. */
export async function loadSettings(ctx: SignCtx): Promise<SignSettingsRow> {
  const first = await ctx.admin.from("sign_settings").select("*").eq("account_id", ctx.accountId).maybeSingle();
  if (first.error) raiseDatabaseError(first.error, "load settings");
  if (first.data) return first.data as SignSettingsRow;
  const ensured = await ctx.admin.rpc("sign_ensure_defaults", { p_account: ctx.accountId });
  if (ensured.error) raiseDatabaseError(ensured.error, "ensure defaults");
  const again = await ctx.admin.from("sign_settings").select("*").eq("account_id", ctx.accountId).maybeSingle();
  if (again.error || !again.data) raiseDatabaseError(again.error, "load settings (second read)");
  return again.data as SignSettingsRow;
}

/**
 * Add an event to a document's audit chain. Never throws: a log write must not undo what it records. With `strict` it does
 * throw when the event was not recorded, for an act that must not happen unrecorded (revealing a sensitive answer).
 */
export async function logEvent(
  ctx: SignCtx,
  documentId: string,
  type: string,
  opts: { actor: "user" | "signer" | "system"; signerId?: string | null; userId?: string | null; detail?: Record<string, unknown>; ip?: string | null; device?: string | null; strict?: boolean },
): Promise<void> {
  try {
    const logged = await ctx.admin.rpc("sign_log", {
      p_document: documentId,
      p_type: type,
      p_actor_type: opts.actor,
      p_signer: opts.signerId ?? null,
      p_user: opts.userId ?? null,
      p_detail: ctx.via ? { ...(opts.detail ?? {}), via: ctx.via } : (opts.detail ?? {}),
      p_ip: opts.ip ?? null,
      p_device: opts.device ?? null,
    });
    if (opts.strict && logged.error) throw new Error(logged.error.message);
  } catch (err) {
    console.error("[sign] could not log event", type, err instanceof Error ? err.message : err);
    if (opts.strict) throw new SignError("audit_unavailable", "The action could not be recorded, so it was not done. Try again.", 503);
  }
}

/** The name of the person who sent a document, and the workspace's name, for messages. */
export async function loadSenderAndWorkspace(
  ctx: SignCtx,
  createdBy: string | null,
): Promise<{ workspaceName: string; senderName: string; senderEmail: string | null; timeZone: string; logoUrl: string | null }> {
  const acct = await ctx.admin.from("accounts").select("name, brand_name, timezone, brand_logo_url").eq("id", ctx.accountId).maybeSingle();
  const a = acct.data as { name?: string; brand_name?: string; timezone?: string; brand_logo_url?: string | null } | null;
  const workspaceName = a?.brand_name?.trim() || a?.name || "Halo";
  const timeZone = a?.timezone || "UTC";
  let senderName = workspaceName;
  let senderEmail: string | null = null;
  if (createdBy) {
    const p = await ctx.admin.from("profiles").select("full_name, email").eq("user_id", createdBy).eq("account_id", ctx.accountId).maybeSingle();
    const row = p.data as { full_name?: string; email?: string } | null;
    if (row?.full_name?.trim()) senderName = row.full_name.trim();
    senderEmail = row?.email?.trim() || null;
  }
  // Workspace logos are public files (the public-assets bucket), so the link can go to a signer as it is.
  const logoUrl = a?.brand_logo_url && /^https:\/\//.test(a.brand_logo_url) ? a.brand_logo_url : null;
  return { workspaceName, senderName, senderEmail, timeZone, logoUrl };
}
