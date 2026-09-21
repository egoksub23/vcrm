import MiniSearch from "minisearch";
import type { HelpSearchDoc } from "./types";

// Full-text search over the guide. The documents are built on the server
// (content.ts) and shipped as JSON; the index is built in the browser on first
// use. ~40 short pages index in a few milliseconds, so there is nothing to
// precompute or to keep in sync.

export interface HelpSearchIndex {
  mini: MiniSearch<HelpSearchDoc>;
  docs: Map<string, HelpSearchDoc>;
}

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

export interface HelpSearchHit {
  id: string;
  title: string;
  section: string;
  href: string;
  snippet: Snippet;
}

// Words too common to help ranking ("how do I reply to a chat").
const STOP_WORDS = new Set(["a","an","the","to","of","in","on","for","and","or","is","it","how","do","i","my","can","you","with","at","be"]);

export function createSearchIndex(docs: HelpSearchDoc[]): HelpSearchIndex {
  const mini = new MiniSearch<HelpSearchDoc>({
    fields: ["title", "headings", "description", "body"],
    storeFields: [],
    idField: "id",
    processTerm: (term) => {
      const t = term.toLowerCase();
      return STOP_WORDS.has(t) ? null : t;
    },
    searchOptions: {
      boost: { title: 6, headings: 3, description: 2 },
      prefix: true,
      fuzzy: (term) => (term.length > 4 ? 0.2 : false),
    },
  });
  mini.addAll(docs);
  return { mini, docs: new Map(docs.map((d) => [d.id, d])) };
}

const SNIPPET_RADIUS = 70;

/** A short excerpt around the first occurrence of any search term. */
export function makeSnippet(text: string, terms: string[]): Snippet {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let at = -1;
  let len = 0;
  for (const raw of terms) {
    const term = raw.toLowerCase();
    if (!term) continue;
    const i = lower.indexOf(term);
    if (i !== -1 && (at === -1 || i < at)) {
      at = i;
      len = term.length;
    }
  }
  if (at === -1) {
    const head = flat.slice(0, SNIPPET_RADIUS * 2);
    return { before: head, match: "", after: flat.length > head.length ? "…" : "" };
  }
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(flat.length, at + len + SNIPPET_RADIUS);
  return {
    before: (start > 0 ? "…" : "") + flat.slice(start, at),
    match: flat.slice(at, at + len),
    after: flat.slice(at + len, end) + (end < flat.length ? "…" : ""),
  };
}

export function searchGuide(index: HelpSearchIndex, query: string, limit = 8): HelpSearchHit[] {
  const q = query.trim();
  if (!q) return [];
  return index.mini
    .search(q)
    .slice(0, limit)
    .flatMap((r) => {
      const doc = index.docs.get(String(r.id));
      if (!doc) return [];
      // Prefer a snippet from the body; fall back to the description.
      const terms = r.terms;
      const fromBody = makeSnippet(doc.body, terms);
      const snippet = fromBody.match ? fromBody : makeSnippet(doc.description, terms);
      return [{ id: doc.id, title: doc.title, section: doc.section, href: doc.id, snippet }];
    });
}
