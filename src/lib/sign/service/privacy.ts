// ============================================================
// Private documents (migration 176): the service layer's half of the rule. The database enforces it with row level security for everything a
// person reads with their own login; but every service here reads with the service role, which no policy applies to, so each read that a person (or
// a key) can reach through the server has to ask the same question itself. This module is that question, once.
//
//   THE RULE   A document (or document collection) that is private is seen, with everything about its progress, only by
//                - the person who uploaded it (created_by),
//                - an admin or owner of the workspace,
//                - a Halo user named as a signer on it (sign_signers.internal_user_id).
//              Everyone else with menu.sign is told "not found", exactly as for a document that does not exist. A document of a private collection is
//              private (the database copies the collection's flag onto each document), so a document alone is judged by its own flag. The collection
//              is one thing (the same people sign all of it in one sitting): a Halo user named on ANY document of a private collection sees the
//              collection and EVERY document of it.
//
//   WHO ASKS   `callerOf(ctx)` says what kind of caller a context is:
//                - a person at a screen (ctx.userId, no `via`): the rule applies to them;
//                - an API key (`via: api_key:...`, whose userId is merely whoever made the key): sees NO private document at all, in lists or by id. A key
//                  is an integration, not a person: nobody can be named on a document as a key, and an integration made for the workspace's own documents
//                  must not reach the ones the uploader chose to keep to a few people;
//                - the system (no user: the jobs that seal, expire and remind, a signer's own link, a public page): not restricted. It acts for the
//                  document, not for a reader.
//
//   WHAT IT COVERS   `loadDocument` and `loadEnvelope` (context.ts, envelope-data.ts) refuse a private document the caller may not see, which is
//                    every service that starts there (all of them); `documentListScope` / `visibleDocuments` narrow the lists the server builds
//                    for a person or a key (the attention list, the CSV export, the zip, the API's list); `assertMayChangePrivacy` decides who
//                    may switch the flag on a draft.
// ============================================================

import type { SignDocumentRow, SignEnvelopeRow } from "../types";
import type { SignCtx } from "./context";
import { SignError, raiseDatabaseError } from "./errors";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IN_CHUNK = 100;
/** The most private documents a person is named on that a list filter carries (beyond that the list shows the newest-named ones; each is still open by its address). */
const NAMED_LIMIT = 300;

export type Caller = { kind: "system" } | { kind: "api" } | { kind: "person"; userId: string };

/** What kind of caller a context stands for (see the header). */
export function callerOf(ctx: SignCtx): Caller {
  if (ctx.via?.startsWith("api_key:")) return { kind: "api" };
  if (ctx.userId) return { kind: "person", userId: ctx.userId };
  return { kind: "system" };
}

/** Whether this person is an admin or owner of the workspace; asked once per context. */
const adminAnswers = new WeakMap<object, Promise<boolean>>();
export async function isAdminOf(ctx: SignCtx, userId: string): Promise<boolean> {
  let pending = adminAnswers.get(ctx);
  if (!pending) {
    pending = (async () => {
      const { data, error } = await ctx.admin.from("profiles").select("account_role").eq("user_id", userId).eq("account_id", ctx.accountId).maybeSingle();
      if (error) raiseDatabaseError(error, "load role");
      const role = (data as { account_role?: string | null } | null)?.account_role;
      return role === "owner" || role === "admin";
    })();
    adminAnswers.set(ctx, pending);
  }
  return pending;
}

async function namedOnDocument(ctx: SignCtx, userId: string, documentId: string): Promise<boolean> {
  const { data, error } = await ctx.admin.from("sign_signers").select("id").eq("document_id", documentId).eq("account_id", ctx.accountId).eq("internal_user_id", userId).limit(1);
  if (error) raiseDatabaseError(error, "check who is named");
  return ((data ?? []) as unknown[]).length > 0;
}

async function namedOnEnvelope(ctx: SignCtx, userId: string, envelopeId: string): Promise<boolean> {
  const docs = await ctx.admin.from("sign_documents").select("id").eq("envelope_id", envelopeId).eq("account_id", ctx.accountId);
  if (docs.error) raiseDatabaseError(docs.error, "check who is named");
  const ids = ((docs.data ?? []) as { id: string }[]).map((d) => d.id);
  if (ids.length === 0) return false;
  const { data, error } = await ctx.admin.from("sign_signers").select("id").in("document_id", ids).eq("account_id", ctx.accountId).eq("internal_user_id", userId).limit(1);
  if (error) raiseDatabaseError(error, "check who is named");
  return ((data ?? []) as unknown[]).length > 0;
}

type PrivateFacts = { id: string; is_private?: boolean | null; created_by?: string | null; envelope_id?: string | null };

/** May the caller see this document? Pure of side effects; asks the database only when the document is private and the caller is a person who is not its uploader. */
export async function canSeeDocument(ctx: SignCtx, doc: PrivateFacts): Promise<boolean> {
  if (doc.is_private !== true) return true;
  const caller = callerOf(ctx);
  if (caller.kind === "system") return true;
  if (caller.kind === "api") return false;
  if (doc.created_by === caller.userId) return true;
  if (await isAdminOf(ctx, caller.userId)) return true;
  if (await namedOnDocument(ctx, caller.userId, doc.id)) return true;
  // a document of a collection is judged with the collection: named on any document of it is named on all of it
  return doc.envelope_id ? namedOnEnvelope(ctx, caller.userId, doc.envelope_id) : false;
}

/** May the caller see this collection? */
export async function canSeeEnvelope(ctx: SignCtx, env: PrivateFacts): Promise<boolean> {
  if (env.is_private !== true) return true;
  const caller = callerOf(ctx);
  if (caller.kind === "system") return true;
  if (caller.kind === "api") return false;
  if (env.created_by === caller.userId) return true;
  if (await isAdminOf(ctx, caller.userId)) return true;
  return namedOnEnvelope(ctx, caller.userId, env.id);
}

/** A private document the caller may not see answers "not found", like a document that is not there. */
export async function assertCanSeeDocument<T extends PrivateFacts>(ctx: SignCtx, doc: T): Promise<T> {
  if (!(await canSeeDocument(ctx, doc))) throw new SignError("document_not_found", "That document was not found.", 404);
  return doc;
}

export async function assertCanSeeEnvelope<T extends PrivateFacts>(ctx: SignCtx, env: T): Promise<T> {
  if (!(await canSeeEnvelope(ctx, env))) throw new SignError("envelope_not_found", "That document collection was not found.", 404);
  return env;
}

/**
 * Who may switch the flag on a draft (or on a collection that is a draft): the person who uploaded it, or an admin or owner. A key never; the
 * system (a job, an automation without a person) may. The caller has already seen the row (loadDocument / loadEnvelope refused it otherwise).
 */
export async function assertMayChangePrivacy(ctx: SignCtx, row: { created_by?: string | null }): Promise<void> {
  const caller = callerOf(ctx);
  if (caller.kind === "system") return;
  if (caller.kind === "person" && (row.created_by === caller.userId || (await isAdminOf(ctx, caller.userId)))) return;
  throw new SignError("private_not_allowed", "Only the person who uploaded this, or an admin, can change this.", 403);
}

/**
 * A private DRAFT is changed, sent or deleted only by its uploader or an admin (the policies say the same). A Halo user named on it reads it and
 * does not edit it: besides being the rule, a person who edits their own place on a draft (or deletes it, one document at a time) would lose sight of
 * it half way through. A document or collection that is not private, or no longer a draft, is not held to this.
 */
export async function assertMayEditDraft(ctx: SignCtx, row: { is_private?: boolean | null; status?: string | null; created_by?: string | null }): Promise<void> {
  if (row.is_private !== true || row.status !== "draft") return;
  await assertMayChangePrivacy(ctx, row);
}

// ---- lists ---------------------------------------------------------------------------------------

/** The filter calls of a PostgREST query builder that a list scope uses (the builder returns itself from each). */
interface Filterable {
  or: (filters: string) => unknown;
  eq: (column: string, value: boolean) => unknown;
}

export interface ListScope {
  /** True when the caller sees every document (an admin, the system): `apply` changes nothing. */
  unrestricted: boolean;
  /** Narrow a query on sign_documents to the documents the caller may see (the same builder comes back). */
  apply<Q>(query: Q): Q;
}

/**
 * The private documents a person is named on (as a Halo signer) and the private collections they are named on (on any document of them, which
 * makes every document of the collection theirs), up to the limit.
 */
async function namedPrivate(ctx: SignCtx, userId: string): Promise<{ documents: string[]; envelopes: string[] }> {
  const s = await ctx.admin.from("sign_signers").select("document_id").eq("account_id", ctx.accountId).eq("internal_user_id", userId).limit(NAMED_LIMIT * 2);
  if (s.error) raiseDatabaseError(s.error, "list where I am named");
  const ids = [...new Set(((s.data ?? []) as { document_id: string }[]).map((r) => r.document_id))];
  const documents: string[] = [];
  const envelopes = new Set<string>();
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const d = await ctx.admin.from("sign_documents").select("id, envelope_id").eq("account_id", ctx.accountId).eq("is_private", true).in("id", ids.slice(i, i + IN_CHUNK));
    if (d.error) raiseDatabaseError(d.error, "list private documents I am named on");
    for (const r of (d.data ?? []) as { id: string; envelope_id?: string | null }[]) {
      if (r.envelope_id) envelopes.add(r.envelope_id);
      else documents.push(r.id);
    }
  }
  return { documents: documents.slice(0, NAMED_LIMIT), envelopes: [...envelopes].slice(0, NAMED_LIMIT) };
}

/**
 * What a list of documents the server builds for this caller must be narrowed to. An admin or the system sees everything; a key sees only the
 * documents that are not private; a person sees the documents that are not private, the ones they uploaded and the private ones they are named on.
 */
export async function documentListScope(ctx: SignCtx): Promise<ListScope> {
  const caller = callerOf(ctx);
  const everything: ListScope = { unrestricted: true, apply: (q) => q };
  if (caller.kind === "system") return everything;
  if (caller.kind === "api") return { unrestricted: false, apply: (q) => (q as unknown as Filterable).eq("is_private", false) as typeof q };
  if (await isAdminOf(ctx, caller.userId)) return everything;
  const named = UUID_RE.test(caller.userId) ? await namedPrivate(ctx, caller.userId) : { documents: [], envelopes: [] };
  const clauses = ["is_private.eq.false"];
  if (UUID_RE.test(caller.userId)) clauses.push(`created_by.eq.${caller.userId}`);
  const docs = named.documents.filter((id) => UUID_RE.test(id));
  const envs = named.envelopes.filter((id) => UUID_RE.test(id));
  if (docs.length > 0) clauses.push(`id.in.(${docs.join(",")})`);
  if (envs.length > 0) clauses.push(`envelope_id.in.(${envs.join(",")})`);
  const filter = clauses.join(",");
  return { unrestricted: false, apply: (q) => (q as unknown as Filterable).or(filter) as typeof q };
}

/** Of rows already read (each with its id, flag and uploader), the ones the caller may see, in the same order. One question to the database however many rows. */
export async function visibleDocuments<T extends PrivateFacts>(ctx: SignCtx, rows: readonly T[]): Promise<T[]> {
  const caller = callerOf(ctx);
  if (caller.kind === "system") return [...rows];
  const hidden = rows.filter((r) => r.is_private === true && !(caller.kind === "person" && r.created_by === caller.userId));
  if (hidden.length === 0) return [...rows];
  if (caller.kind === "api") return rows.filter((r) => r.is_private !== true);
  if (await isAdminOf(ctx, caller.userId)) return [...rows];
  const named = new Set<string>();
  const ids = hidden.map((r) => r.id);
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await ctx.admin.from("sign_signers").select("document_id").eq("account_id", ctx.accountId).eq("internal_user_id", caller.userId).in("document_id", ids.slice(i, i + IN_CHUNK));
    if (error) raiseDatabaseError(error, "check who is named");
    for (const r of (data ?? []) as { document_id: string }[]) named.add(r.document_id);
  }
  // a document of a collection the person is named on (on any of its documents) is theirs too
  const envelopes = [...new Set(hidden.map((r) => r.envelope_id).filter((e): e is string => !!e))];
  const namedEnvelopes = new Set<string>();
  for (let i = 0; i < envelopes.length; i += IN_CHUNK) {
    const docs = await ctx.admin.from("sign_documents").select("id, envelope_id").eq("account_id", ctx.accountId).in("envelope_id", envelopes.slice(i, i + IN_CHUNK));
    if (docs.error) raiseDatabaseError(docs.error, "check who is named");
    const byDoc = new Map(((docs.data ?? []) as { id: string; envelope_id: string }[]).map((d) => [d.id, d.envelope_id]));
    const ofEnvelopes = [...byDoc.keys()];
    for (let j = 0; j < ofEnvelopes.length; j += IN_CHUNK) {
      const s = await ctx.admin.from("sign_signers").select("document_id").eq("account_id", ctx.accountId).eq("internal_user_id", caller.userId).in("document_id", ofEnvelopes.slice(j, j + IN_CHUNK));
      if (s.error) raiseDatabaseError(s.error, "check who is named");
      for (const r of (s.data ?? []) as { document_id: string }[]) {
        const e = byDoc.get(r.document_id);
        if (e) namedEnvelopes.add(e);
      }
    }
  }
  return rows.filter((r) => r.is_private !== true || r.created_by === caller.userId || named.has(r.id) || (!!r.envelope_id && namedEnvelopes.has(r.envelope_id)));
}

/** The "private" choice of a request: a boolean in JSON, or the text "true" / "false" of a multipart field. Undefined when it was not given; anything else is a 400. */
export function parsePrivate(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (raw === true || raw === "true") return true;
  if (raw === false || raw === "false") return false;
  throw new SignError("bad_private", "Choose whether this is private.", 400);
}

/** The row's own flag as a plain boolean (an old row, or a fixture without the column, is not private). */
export const isPrivate = (row: Pick<SignDocumentRow, "is_private"> | Pick<SignEnvelopeRow, "is_private">): boolean => row.is_private === true;
