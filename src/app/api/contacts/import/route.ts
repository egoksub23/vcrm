import { NextResponse } from "next/server";
import { requireCapability, toErrorResponse } from "@/lib/auth/account";
import { dedupeByPhone, isUniqueViolation, normalizeKey } from "@/lib/contacts/dedupe";
import { resolveImportTagIds, assignImportedContactTags } from "@/lib/contacts/resolve-import-tags";
import type { ParsedContactRow } from "@/lib/contacts/parse-contact-csv";
import type { PgDb } from "@/lib/postgres/db";

export async function POST(request: Request) {
  try {
    const ctx = await requireCapability("contacts.edit");
    const body = (await request.json().catch(() => null)) as {
      rows: ParsedContactRow[];
      canCreateTags?: boolean;
    } | null;
    if (!body?.rows) return NextResponse.json({ error: "rows required" }, { status: 400 });

    const { rows, canCreateTags = false } = body;

    // 1) De-dupe within the file by normalized phone (keep first).
    const { unique, duplicates: inFileDupes, invalid: invalidPhone } = dedupeByPhone(rows);

    let skipped = inFileDupes;

    // 2) Skip numbers already in this account.
    const { data: existingRows } = await ctx.supabase
      .from("contacts")
      .select("phone_normalized")
      .eq("account_id", ctx.accountId);
    const existing = new Set(
      (existingRows ?? [])
        .map((r: { phone_normalized: string | null }) => r.phone_normalized)
        .filter((p: string | null): p is string => !!p)
    );

    const toInsert = unique.filter((row) => {
      if (existing.has(normalizeKey(row.phone))) {
        skipped++;
        return false;
      }
      return true;
    });

    // 3) Resolve tag names → ids.
    const allTagNames = toInsert.flatMap((row) => row.tagNames);
    let tagIdByKey = new Map<string, string>();
    let skippedTagNames: string[] = [];
    if (allTagNames.length > 0) {
      ({ tagIdByKey, skippedNames: skippedTagNames } = await resolveImportTagIds(
        ctx.supabase as unknown as PgDb,
        {
          accountId: ctx.accountId,
          userId: ctx.userId,
          tagNames: allTagNames,
          canCreateTags,
        }
      ));
    }

    const tagAssignments: { contactId: string; tagNames: string[] }[] = [];
    let imported = 0;
    let failed = 0;
    const failedDetails: { phone: string; name?: string; reason: string }[] = [];

    // 4) Batch insert in chunks of 50.
    const chunkSize = 50;
    for (let i = 0; i < toInsert.length; i += chunkSize) {
      const chunk = toInsert.slice(i, i + chunkSize);
      const dbRows = chunk.map((row) => ({
        user_id: ctx.userId,
        account_id: ctx.accountId,
        phone: row.phone,
        name: row.name || null,
        email: row.email || null,
        company: row.company || null,
      }));

      const { data, error } = await ctx.supabase
        .from("contacts")
        .insert(dbRows)
        .select("id");

      if (error) {
        // Retry individually so one bad row doesn't sink the chunk.
        for (let j = 0; j < dbRows.length; j++) {
          const row = dbRows[j];
          const source = chunk[j];
          const { data: singleData, error: singleErr } = await ctx.supabase
            .from("contacts")
            .insert(row)
            .select("id")
            .single();

          if (!singleErr && singleData) {
            imported++;
            if (source.tagNames.length > 0) {
              tagAssignments.push({ contactId: (singleData as { id: string }).id, tagNames: source.tagNames });
            }
          } else if (isUniqueViolation(singleErr)) {
            skipped++;
          } else {
            failed++;
            failedDetails.push({
              phone: row.phone,
              name: row.name ?? undefined,
              reason:
                (singleErr as { message?: string } | null)?.message === "contact_limit_reached"
                  ? "contact_limit_reached"
                  : (singleErr as { message?: string } | null)?.message || "unknown",
            });
          }
        }
      } else {
        const inserted = data ?? [];
        imported += inserted.length;
        for (let j = 0; j < inserted.length; j++) {
          const source = chunk[j];
          if (!source || source.tagNames.length === 0) continue;
          tagAssignments.push({ contactId: (inserted[j] as { id: string }).id, tagNames: source.tagNames });
        }
      }
    }

    // 5) Assign tags.
    let tagsAssigned = 0;
    try {
      tagsAssigned = await assignImportedContactTags(
        ctx.supabase as unknown as PgDb,
        tagAssignments,
        tagIdByKey
      );
    } catch {
      // tag assignment failure must not mask successful import
    }

    return NextResponse.json({ imported, skipped, failed, invalidPhone, failedDetails, tagsAssigned, skippedTagNames });
  } catch (err) {
    return toErrorResponse(err);
  }
}
