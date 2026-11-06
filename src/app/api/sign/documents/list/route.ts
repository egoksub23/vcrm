import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import {
  STATUS_GROUPS,
  narrowByGroup,
  signerSearchClause,
  searchClause,
  validDay,
  type ListFilters,
  type StatusGroup,
} from "@/lib/sign/client/list-filters";
import { createdRange } from "@/lib/sign/export/documents";
import {
  envelopesIncluded,
  envelopeToRow,
  mergeNewestFirst,
  type EnvelopeListRaw,
} from "@/lib/sign/client/list-merge";

const SELECT =
  "id, reference, title, status, mode, test, is_private, category_id, contact_id, sign_in_order, sent_at, expires_at, completed_at, cancelled_at, created_by, created_at, updated_at, contacts(name), sign_signers(id, full_name, status, order_no, kind, part_keys, alternate_of)";

const ENVELOPE_SELECT =
  "id, reference, title, status, is_private, contact_id, sign_in_order, sent_at, expires_at, completed_at, cancelled_at, created_by, created_at, updated_at, contacts(name), sign_documents!sign_documents_envelope_fk(id, title, status, envelope_position, sign_signers(id, full_name, status, order_no, kind, part_keys, party_id))";

interface Filterable {
  in(column: string, values: readonly string[]): Filterable;
  is(column: string, value: null): Filterable;
  not(column: string, operator: string, value: null): Filterable;
  eq(column: string, value: string): Filterable;
  or(filters: string): Filterable;
  gte(column: string, value: string): Filterable;
  lt(column: string, value: string): Filterable;
}

type Range = { gte: string | null; lt: string | null };

function narrowShared<T>(query: T, f: ListFilters, range: Range): T {
  let q = query as unknown as Filterable;
  if (f.contactId) q = q.eq("contact_id", f.contactId);
  if (range.gte) q = q.gte("created_at", range.gte);
  if (range.lt) q = q.lt("created_at", range.lt);
  return q as unknown as T;
}

function narrow<T>(query: T, group: StatusGroup | null, f: ListFilters, clause: string | null, range: Range): T {
  let q = narrowByGroup(query, group) as unknown as Filterable;
  if (group === "test") q = q.eq("test", "true");
  if (f.category === "none") q = q.is("category_id", null);
  else if (f.category !== "all") q = q.eq("category_id", f.category);
  q = narrowShared(q, f, range) as unknown as Filterable;
  if (clause) q = q.or(clause);
  return q as unknown as T;
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const body = (await request.json().catch(() => null)) as {
      filters?: ListFilters;
      want?: number;
      timeZone?: string;
    } | null;

    const f = body?.filters ?? { group: "all" as const, category: "all", search: "" };
    const want = body?.want ?? 25;
    const timeZone = body?.timeZone ?? "UTC";
    const range: Range = createdRange({ from: validDay(f.from) || null, to: validDay(f.to) || null }, timeZone);

    // Signer search
    const signerClause = signerSearchClause(f.search);
    let signerDocIds: string[] = [];
    let signerEnvIds: string[] = [];
    if (signerClause) {
      const { data } = await ctx.supabase
        .from("sign_signers")
        .select("document_id, sign_documents(envelope_id)")
        .eq("account_id", ctx.accountId)
        .or(signerClause)
        .limit(200);
      const rows = (data as unknown as { document_id: string; sign_documents: { envelope_id: string | null } | null }[] | null) ?? [];
      signerDocIds = [...new Set(rows.map((r) => r.document_id))];
      signerEnvIds = [...new Set(rows.map((r) => r.sign_documents?.envelope_id).filter((id): id is string => !!id))];
    }

    const docClause = searchClause(f.search, signerDocIds);
    const envClause = searchClause(f.search, signerEnvIds);

    // Rows
    const docQuery = ctx.supabase
      .from("sign_documents")
      .select(SELECT)
      .eq("account_id", ctx.accountId)
      .is("envelope_id", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false });
    const { data: docData, error: docErr } = await (narrow(docQuery, f.group, f, docClause, range) as unknown as { range(a: number, b: number): Promise<{ data: unknown; error: { message: string } | null }> }).range(0, want - 1);
    if (docErr) return NextResponse.json({ error: docErr.message }, { status: 500 });

    let envRows: ReturnType<typeof envelopeToRow>[] = [];
    if (envelopesIncluded(f)) {
      let envQ = narrowByGroup(
        ctx.supabase
          .from("sign_envelopes")
          .select(ENVELOPE_SELECT)
          .eq("account_id", ctx.accountId)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false }),
        f.group,
      ) as unknown as Filterable;
      envQ = narrowShared(envQ, f, range);
      if (envClause) envQ = envQ.or(envClause);
      const envRes = await (envQ as unknown as { range(a: number, b: number): Promise<{ data: unknown; error: { message: string } | null }> }).range(0, want - 1);
      if (envRes.error) return NextResponse.json({ error: envRes.error.message }, { status: 500 });
      envRows = ((envRes.data as EnvelopeListRaw[] | null) ?? []).map(envelopeToRow);
    }

    const page = mergeNewestFirst((docData as unknown[]) ?? [], envRows, want);

    // Counts
    const withEnvelopes = envelopesIncluded(f);
    const countEntries = await Promise.all(
      STATUS_GROUPS.map(async (g) => {
        const { count, error } = await (narrow(
          ctx.supabase.from("sign_documents").select("id", { count: "exact", head: true }).eq("account_id", ctx.accountId).is("envelope_id", null),
          g, f, docClause, range,
        ) as unknown as Promise<{ count: number | null; error: { message: string } | null }>);
        if (error) throw new Error(error.message);
        let extra = 0;
        if (withEnvelopes && g !== "test") {
          let envCQ = narrowByGroup(
            ctx.supabase.from("sign_envelopes").select("id", { count: "exact", head: true }).eq("account_id", ctx.accountId),
            g,
          ) as unknown as Filterable;
          envCQ = narrowShared(envCQ, f, range);
          if (envClause) envCQ = envCQ.or(envClause);
          const envCRes = await (envCQ as unknown as Promise<{ count: number | null; error: { message: string } | null }>);
          if (envCRes.error) throw new Error(envCRes.error.message);
          extra = envCRes.count ?? 0;
        }
        return [g, (count ?? 0) + extra] as const;
      }),
    );
    const counts = Object.fromEntries(countEntries);

    return NextResponse.json({ rows: page.rows, hasMore: page.hasMore, counts });
  } catch (err) {
    return toErrorResponse(err);
  }
}
