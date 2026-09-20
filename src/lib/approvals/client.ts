// ============================================================
// Browser-side calls for propose and approve.
//
// Tags and labels are written straight from the browser (Supabase client);
// when the caller only has `tags.propose` they go through the propose RPCs
// instead, which record a pending proposal. Everything here returns a
// friendly `{ ok, code }` so the screens can toast a translated message.
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";

import { approvalErrorCode } from "./rules";
import type { ApprovalErrorCode, ApprovalItem, TagValues } from "./types";

export type ProposalResult =
  | { ok: true; id: string | null; mode: "created" | "updated" | "proposed" }
  | { ok: false; code: ApprovalErrorCode };

function toResult(
  data: unknown,
  error: { message?: string | null; code?: string | null } | null,
): ProposalResult {
  if (error) return { ok: false, code: approvalErrorCode(error) };
  const d = (data ?? {}) as { id?: string; mode?: "created" | "updated" | "proposed" };
  return { ok: true, id: d.id ?? null, mode: d.mode ?? "proposed" };
}

/** Propose a new contact tag or conversation label (or create it when the caller can manage tags). */
export async function proposeTag(
  supabase: SupabaseClient,
  input: {
    kind: "tag" | "label";
    name: string;
    color: string;
    description: string | null;
    alsoOther: boolean;
  },
): Promise<ProposalResult> {
  const { data, error } = await supabase.rpc("propose_tag", {
    p_kind: input.kind,
    p_name: input.name,
    p_color: input.color,
    p_description: input.description,
    p_also_other: input.alsoOther,
  });
  return toResult(data, error);
}

/** Propose an edit of a tag or label (or apply it when the caller can manage tags). */
export async function proposeTagEdit(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<TagValues>,
): Promise<ProposalResult> {
  const { data, error } = await supabase.rpc("propose_tag_edit", {
    p_id: id,
    p_patch: patch,
  });
  return toResult(data, error);
}

/** Withdraw a pending proposal, or dismiss a rejected one. Goes through the route (which checks the capability). */
export async function withdrawProposal(
  entityType: "tag" | "snippet",
  id: string,
): Promise<{ ok: true } | { ok: false; code: ApprovalErrorCode }> {
  try {
    const res = await fetch("/api/account/approvals/withdraw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entity_type: entityType, id }),
    });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => ({}))) as { code?: ApprovalErrorCode };
    return { ok: false, code: data.code ?? "unknown" };
  } catch {
    return { ok: false, code: "unknown" };
  }
}

export async function fetchApprovals(params: {
  tab: "pending" | "decided";
  type?: string | null;
  proposer?: string | null;
  since?: string | null;
}): Promise<{ ok: true; items: ApprovalItem[] } | { ok: false }> {
  const sp = new URLSearchParams({ tab: params.tab });
  if (params.type) sp.set("type", params.type);
  if (params.proposer) sp.set("proposer", params.proposer);
  if (params.since) sp.set("since", params.since);
  try {
    const res = await fetch(`/api/account/approvals?${sp.toString()}`, { cache: "no-store" });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { items?: ApprovalItem[] };
    return { ok: true, items: data.items ?? [] };
  } catch {
    return { ok: false };
  }
}

export interface DecideInput {
  entity_type: string;
  id: string;
  decision: "approve" | "reject";
  note?: string;
  edited?: Record<string, unknown>;
}

export async function decideApproval(
  input: DecideInput,
): Promise<{ ok: true; warning?: string } | { ok: false; code: ApprovalErrorCode }> {
  try {
    const res = await fetch("/api/account/approvals/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const data = (await res.json().catch(() => ({}))) as {
      code?: ApprovalErrorCode;
      warning?: string;
    };
    if (res.ok) return { ok: true, warning: data.warning };
    return { ok: false, code: data.code ?? "unknown" };
  } catch {
    return { ok: false, code: "unknown" };
  }
}

export async function approveMany(
  items: { entity_type: string; id: string }[],
): Promise<{ ok: true; approved: number; failed: number } | { ok: false }> {
  try {
    const res = await fetch("/api/account/approvals/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision: "approve", items }),
    });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { approved?: number; failed?: number };
    return { ok: true, approved: data.approved ?? 0, failed: data.failed ?? 0 };
  } catch {
    return { ok: false };
  }
}
