import { NextResponse } from "next/server";
import { getCurrentAccount, toErrorResponse } from "@/lib/auth/account";
import { normalizeKey } from "@/lib/contacts/dedupe";

type CustomFieldOperator = "is" | "is_not" | "contains";

interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

interface AudienceConfig {
  type: "all" | "tags" | "custom_field" | "csv";
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
}

type VariableMapping =
  | { type: "static"; value: string }
  | { type: "field"; value: string }
  | { type: "custom_field"; value: string };

interface MessageTemplate {
  name: string;
  language?: string;
  header_type?: string;
}

interface BroadcastPayload {
  name: string;
  template: MessageTemplate;
  audience: AudienceConfig;
  variables: Record<string, VariableMapping>;
  headerMediaUrl?: string;
}

interface ContactRow {
  id: string;
  phone?: string | null;
  name?: string | null;
  email?: string | null;
  company?: string | null;
  [key: string]: unknown;
}

const INSERT_CHUNK = 200;

async function fetchCustomValueIndex(
  supabase: Awaited<ReturnType<typeof getCurrentAccount>>["supabase"],
  accountId: string,
  contactIds: string[],
): Promise<Map<string, Map<string, string>>> {
  const index = new Map<string, Map<string, string>>();
  if (contactIds.length === 0) return index;
  const PAGE = 500;
  for (let i = 0; i < contactIds.length; i += PAGE) {
    const slice = contactIds.slice(i, i + PAGE);
    const { data } = await supabase
      .from("contact_custom_values")
      .select("contact_id, custom_field_id, value")
      .eq("account_id", accountId)
      .in("contact_id", slice);
    for (const row of (data as { contact_id: string; custom_field_id: string; value: string | null }[] | null) ?? []) {
      const bucket = index.get(row.contact_id) ?? new Map<string, string>();
      bucket.set(row.custom_field_id, row.value ?? "");
      index.set(row.contact_id, bucket);
    }
  }
  return index;
}

function resolveVariables(
  variables: Record<string, VariableMapping>,
  contact: ContactRow,
  customValues?: Map<string, string>,
): string[] {
  const keys = Object.keys(variables).sort((a, b) => {
    const an = Number(a);
    const bn = Number(b);
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
    return a.localeCompare(b);
  });
  return keys.map((key) => {
    const v = variables[key];
    if (v.type === "static") return v.value;
    if (v.type === "field") {
      const fieldMap: Record<string, string | undefined> = {
        name: contact.name ?? undefined,
        phone: contact.phone ?? undefined,
        email: contact.email ?? undefined,
        company: contact.company ?? undefined,
      };
      return fieldMap[v.value] ?? "";
    }
    return customValues?.get(v.value) ?? "";
  });
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const payload = (await request.json().catch(() => null)) as BroadcastPayload | null;
    if (!payload) return NextResponse.json({ error: "invalid body" }, { status: 400 });

    const { audience, name, template, variables } = payload;

    // ── Resolve audience contacts ─────────────────────────────────────
    let contacts: ContactRow[] = [];

    if (audience.type === "all") {
      const { data, error } = await ctx.supabase
        .from("contacts")
        .select("*")
        .eq("account_id", ctx.accountId);
      if (error) return NextResponse.json({ error: `Failed to fetch contacts: ${error.message}` }, { status: 500 });
      contacts = (data as ContactRow[]) ?? [];
    } else if (audience.type === "tags" && audience.tagIds && audience.tagIds.length > 0) {
      const { data: contactTags, error: tagError } = await ctx.supabase
        .from("contact_tags")
        .select("contact_id")
        .eq("account_id", ctx.accountId)
        .in("tag_id", audience.tagIds);
      if (tagError) return NextResponse.json({ error: `Failed to fetch contact tags: ${tagError.message}` }, { status: 500 });
      if (contactTags && contactTags.length > 0) {
        const uniqueIds = [...new Set((contactTags as { contact_id: string }[]).map((ct) => ct.contact_id))];
        const { data, error } = await ctx.supabase
          .from("contacts")
          .select("*")
          .eq("account_id", ctx.accountId)
          .in("id", uniqueIds);
        if (error) return NextResponse.json({ error: `Failed to fetch contacts: ${error.message}` }, { status: 500 });
        contacts = (data as ContactRow[]) ?? [];
      }
    } else if (audience.type === "custom_field" && audience.customField) {
      const { fieldId, operator, value } = audience.customField;
      let query = ctx.supabase
        .from("contact_custom_values")
        .select("contact_id")
        .eq("account_id", ctx.accountId)
        .eq("custom_field_id", fieldId);
      if (operator === "is") query = query.eq("value", value);
      else if (operator === "is_not") query = query.neq("value", value);
      else if (operator === "contains") query = query.ilike("value", `%${value}%`);
      const { data: matches, error: matchErr } = await query;
      if (matchErr) return NextResponse.json({ error: `Custom-field filter failed: ${matchErr.message}` }, { status: 500 });
      const contactIds = [...new Set((matches as { contact_id: string }[] | null ?? []).map((m) => m.contact_id))];
      if (contactIds.length > 0) {
        const { data, error } = await ctx.supabase
          .from("contacts")
          .select("*")
          .eq("account_id", ctx.accountId)
          .in("id", contactIds);
        if (error) return NextResponse.json({ error: `Failed to fetch contacts: ${error.message}` }, { status: 500 });
        contacts = (data as ContactRow[]) ?? [];
      }
    } else if (audience.type === "csv" && audience.csvContacts) {
      // Upsert CSV contacts: deduplicate, look up existing, insert missing
      const csvRows = audience.csvContacts;
      if (csvRows.length > 0) {
        const uniqueByKey = new Map<string, { phone: string; name?: string }>();
        for (const row of csvRows) {
          const key = normalizeKey(row.phone);
          if (key && !uniqueByKey.has(key)) uniqueByKey.set(key, row);
        }
        const keys = [...uniqueByKey.keys()];

        const { data: existing, error: lookupErr } = await ctx.supabase
          .from("contacts")
          .select("*")
          .eq("account_id", ctx.accountId)
          .in("phone_normalized", keys);
        if (lookupErr) return NextResponse.json({ error: `Failed to look up CSV contacts: ${lookupErr.message}` }, { status: 500 });

        const byKey = new Map<string, ContactRow>();
        for (const c of (existing as ContactRow[] | null) ?? []) {
          const key = normalizeKey((c.phone as string) ?? "");
          if (key) byKey.set(key, c);
        }

        const missing = keys
          .filter((k) => !byKey.has(k))
          .map((k) => uniqueByKey.get(k)!)
          .map((row) => ({
            user_id: ctx.userId,
            account_id: ctx.accountId,
            phone: row.phone,
            name: row.name ?? null,
          }));

        for (let i = 0; i < missing.length; i += INSERT_CHUNK) {
          const chunk = missing.slice(i, i + INSERT_CHUNK);
          const { data: inserted, error: insertErr } = await ctx.supabase
            .from("contacts")
            .insert(chunk)
            .select();
          if (insertErr) return NextResponse.json({ error: `Failed to create CSV contacts: ${insertErr.message}` }, { status: 500 });
          for (const c of (inserted as ContactRow[] | null) ?? []) {
            const key = normalizeKey((c.phone as string) ?? "");
            if (key) byKey.set(key, c);
          }
        }

        contacts = keys.map((k) => byKey.get(k)).filter((c): c is ContactRow => Boolean(c));
      }
    }

    // Apply exclude tags
    if (audience.excludeTagIds && audience.excludeTagIds.length > 0) {
      const { data: excludeRows } = await ctx.supabase
        .from("contact_tags")
        .select("contact_id")
        .eq("account_id", ctx.accountId)
        .in("tag_id", audience.excludeTagIds);
      const excludedIds = new Set((excludeRows as { contact_id: string }[] | null ?? []).map((r) => r.contact_id));
      contacts = contacts.filter((c) => !excludedIds.has(c.id));
    }

    if (contacts.length === 0) {
      return NextResponse.json({ error: "No contacts found for this audience." }, { status: 422 });
    }

    // ── Create broadcast row ──────────────────────────────────────────
    const { data: broadcast, error: broadcastError } = await ctx.supabase
      .from("broadcasts")
      .insert({
        user_id: ctx.userId,
        account_id: ctx.accountId,
        name,
        template_name: template.name,
        template_language: template.language ?? "en_US",
        template_variables: variables,
        audience_filter: {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          excludeTagIds: audience.excludeTagIds,
        },
        status: "sending",
        total_recipients: contacts.length,
        sent_count: 0,
        delivered_count: 0,
        read_count: 0,
        replied_count: 0,
        failed_count: 0,
      })
      .select()
      .single();

    if (broadcastError || !broadcast) {
      return NextResponse.json({ error: `Failed to create broadcast: ${broadcastError?.message ?? "unknown"}` }, { status: 500 });
    }

    // ── Resolve custom-field values and build recipient rows ──────────
    const customValueIndex = await fetchCustomValueIndex(ctx.supabase, ctx.accountId, contacts.map((c) => c.id));
    const recipientRows = contacts.map((contact) => ({
      broadcast_id: (broadcast as { id: string }).id,
      contact_id: contact.id,
      status: "pending" as const,
      template_params: resolveVariables(variables, contact, customValueIndex.get(contact.id)),
    }));

    // ── Insert recipient rows in batches ─────────────────────────────
    for (let i = 0; i < recipientRows.length; i += INSERT_CHUNK) {
      const batch = recipientRows.slice(i, i + INSERT_CHUNK);
      const { error: recipientError } = await ctx.supabase
        .from("broadcast_recipients")
        .insert(batch);
      if (recipientError) {
        await ctx.supabase
          .from("broadcasts")
          .update({ status: "failed", failed_count: contacts.length })
          .eq("id", (broadcast as { id: string }).id);
        return NextResponse.json({ error: `Failed to insert recipient batch ${i / INSERT_CHUNK + 1}: ${recipientError.message}` }, { status: 500 });
      }
    }

    // ── Fetch back recipients with contact data ────────────────────────
    const { data: recipients, error: recipientsFetchError } = await ctx.supabase
      .from("broadcast_recipients")
      .select("*, contact:contacts(*)")
      .eq("broadcast_id", (broadcast as { id: string }).id);

    if (recipientsFetchError || !recipients) {
      return NextResponse.json({ error: "Failed to fetch broadcast recipients" }, { status: 500 });
    }

    return NextResponse.json({ broadcastId: (broadcast as { id: string }).id, recipients });
  } catch (err) {
    return toErrorResponse(err);
  }
}
