// ============================================================
// Doc Sign, browser side (migration 171): the documents list shows an ENVELOPE as one row among the documents. Pure functions: an
// envelope read with its documents and their people becomes a list row (its people are the PERSONS, not one entry per document), and
// the two sources (documents that are on their own, envelopes) are merged newest first. Tested without a screen or a database.
// ============================================================

import type { DocumentStatus, SignerKind } from "../types";
import type { ListFilters } from "./list-filters";

/** What a list row needs of a person (the shape of the documents list's `sign_signers`). */
export interface ListPerson {
  id: string;
  full_name: string;
  status: string;
  order_no: number;
  kind: SignerKind;
  part_keys?: string[] | null;
}

/** One signing row of a document of an envelope, as read for the list. */
export interface EnvelopeListSigner extends ListPerson {
  party_id: string | null;
}

export interface EnvelopeListDocument {
  id: string;
  title: string;
  status: DocumentStatus;
  envelope_position: number | null;
  sign_signers: EnvelopeListSigner[] | null;
}

/** An envelope as the list reads it. */
export interface EnvelopeListRaw {
  id: string;
  reference: string | null;
  title: string;
  status: DocumentStatus;
  /** Migration 176. */
  is_private?: boolean;
  contact_id: string | null;
  sign_in_order: boolean;
  sent_at: string | null;
  expires_at: string | null;
  completed_at: string | null;
  /** Migration 181. */
  cancelled_at?: string | null;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
  contacts: { name: string | null } | null;
  sign_documents: EnvelopeListDocument[] | null;
}

/** The part of a list row the merge looks at (the list's own row type has it and more). */
export interface Mergeable {
  id: string;
  created_at: string;
}

/** What an envelope's row carries beyond a document's. */
export interface EnvelopeRowExtras {
  kind: "envelope";
  /** Its documents in order, for the count and the states. */
  envelope_documents: { id: string; title: string; status: DocumentStatus; position: number }[];
}

/**
 * The people of an envelope: the rows one person has on the different documents are ONE person. Their state is "signed" once they have
 * signed everything, "declined" if they declined, otherwise how far they have got (viewed, invited, not yet). The anchor row (the one on
 * their first document) gives the name and the turn.
 */
export function envelopePeople(documents: readonly EnvelopeListDocument[]): ListPerson[] {
  const groups = new Map<string, EnvelopeListSigner[]>();
  for (const d of documents) {
    for (const s of d.sign_signers ?? []) {
      if (s.part_keys && s.part_keys.length > 0) continue;
      const key = s.party_id ?? s.id;
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
  }
  const people: ListPerson[] = [];
  for (const [key, rows] of groups) {
    const anchor = rows.find((r) => r.id === key) ?? rows[0];
    const has = (s: string) => rows.some((r) => r.status === s);
    const status = has("declined") ? "declined" : rows.every((r) => r.status === "signed") ? "signed" : has("viewed") ? "viewed" : has("sent") ? "sent" : has("signed") ? "viewed" : "pending";
    people.push({ id: key, full_name: anchor.full_name, status, order_no: anchor.order_no, kind: anchor.kind });
  }
  return people.sort((a, b) => a.order_no - b.order_no || a.full_name.localeCompare(b.full_name));
}

/** An envelope as a row of the list (a document-shaped row with `kind: "envelope"`). */
export function envelopeToRow(e: EnvelopeListRaw): {
  id: string;
  reference: string | null;
  title: string;
  status: DocumentStatus;
  is_private: boolean;
  category_id: null;
  contact_id: string | null;
  sign_in_order: boolean;
  sent_at: string | null;
  expires_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  contacts: { name: string | null } | null;
  sign_signers: ListPerson[];
} & EnvelopeRowExtras {
  const documents = [...(e.sign_documents ?? [])].sort((a, b) => (a.envelope_position ?? 0) - (b.envelope_position ?? 0));
  return {
    id: e.id,
    reference: e.reference,
    title: e.title,
    status: e.status,
    is_private: e.is_private === true,
    category_id: null,
    contact_id: e.contact_id,
    sign_in_order: e.sign_in_order,
    sent_at: e.sent_at,
    expires_at: e.expires_at,
    completed_at: e.completed_at,
    cancelled_at: e.cancelled_at ?? null,
    created_by: e.created_by ?? null,
    created_at: e.created_at,
    updated_at: e.updated_at,
    contacts: e.contacts,
    sign_signers: envelopePeople(documents),
    kind: "envelope",
    envelope_documents: documents.map((d, i) => ({ id: d.id, title: d.title, status: d.status, position: d.envelope_position ?? i + 1 })),
  };
}

/** Whether envelopes belong in the list for these filters: they have no category (so "none" keeps them) and are never tests. */
export function envelopesIncluded(f: ListFilters): boolean {
  return f.group !== "test" && (f.category === "all" || f.category === "none");
}

/**
 * Two lists, each already newest first and each read from its own start to `want` rows, as one list newest first, cut to `want`. `hasMore`
 * is true when anything was left out or a source may have more than it returned.
 */
export function mergeNewestFirst<A extends Mergeable, B extends Mergeable>(documents: readonly A[], envelopes: readonly B[], want: number): { rows: (A | B)[]; hasMore: boolean } {
  const all: (A | B)[] = [...documents, ...envelopes].sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const hasMore = documents.length >= want || envelopes.length >= want || all.length > want;
  return { rows: all.slice(0, want), hasMore };
}

/** Where a row opens: a document's page, or an envelope's. */
export function rowHref(row: { id: string; kind?: "envelope" }): string {
  return row.kind === "envelope" ? `/sign/envelopes/${row.id}` : `/sign/${row.id}`;
}
