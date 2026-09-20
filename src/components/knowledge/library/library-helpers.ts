import type { ArticleDraftSeed, KnowledgeDocSummary } from '@/lib/knowledge-types';

// Pure helpers for the knowledge library screen: which view shows which
// articles, the counts on the left rail, and small formatters. Kept apart
// from the components so the rules are testable.

export type LibraryView =
  | 'all'
  | 'drafts'
  | 'review'
  | 'agents'
  | 'gaps'
  | 'insights'
  | `collection:${string}`;

/** Views that list articles in the table (the others have their own screen). */
export function isListView(view: LibraryView): boolean {
  return view !== 'gaps' && view !== 'insights';
}

export const collectionView = (id: string): LibraryView => `collection:${id}`;

export function collectionIdOfView(view: LibraryView): string | null {
  return view.startsWith('collection:') ? view.slice('collection:'.length) : null;
}

/** A published article whose "review by" date has arrived. Drafts are not
 *  live, so they are not "due" for anything. */
export function isReviewDue(d: Pick<KnowledgeDocSummary, 'status' | 'review_by'>, today: string): boolean {
  return d.status === 'published' && !!d.review_by && d.review_by <= today;
}

export type DocStatus = 'draft' | 'review' | 'published';

export function docStatusOf(d: Pick<KnowledgeDocSummary, 'status' | 'review_by'>, today: string): DocStatus {
  if (d.status === 'draft') return 'draft';
  return isReviewDue(d, today) ? 'review' : 'published';
}

export interface LibraryFilters {
  view: LibraryView;
  /** '' = every language. */
  language: string;
  query: string;
  /** yyyy-MM-dd, so "review due" is decided by the caller's clock. */
  today: string;
}

export function filterDocs(docs: KnowledgeDocSummary[], f: LibraryFilters): KnowledgeDocSummary[] {
  const needle = f.query.trim().toLowerCase();
  const collectionId = collectionIdOfView(f.view);
  return docs.filter((d) => {
    if (f.language && d.language !== f.language) return false;
    if (collectionId && d.collection_id !== collectionId) return false;
    if (f.view === 'drafts' && d.status !== 'draft') return false;
    if (f.view === 'review' && !isReviewDue(d, f.today)) return false;
    if (f.view === 'agents' && d.use_in_ai) return false;
    if (needle && !`${d.title} ${d.category ?? ''}`.toLowerCase().includes(needle)) return false;
    return true;
  });
}

export interface LibraryCounts {
  all: number;
  published: number;
  drafts: number;
  review: number;
  agents: number;
  /** Articles per collection id. */
  byCollection: Record<string, number>;
}

export function countDocs(docs: KnowledgeDocSummary[], today: string): LibraryCounts {
  const c: LibraryCounts = { all: docs.length, published: 0, drafts: 0, review: 0, agents: 0, byCollection: {} };
  for (const d of docs) {
    if (d.status === 'published') c.published++;
    else c.drafts++;
    if (isReviewDue(d, today)) c.review++;
    if (!d.use_in_ai) c.agents++;
    if (d.collection_id) c.byCollection[d.collection_id] = (c.byCollection[d.collection_id] ?? 0) + 1;
  }
  return c;
}

/** Only #rgb / #rrggbb reach a style attribute; anything else gets the default. */
export const DEFAULT_COLLECTION_COLOR = '#7C3AED';
export function safeHexColor(v: string | null | undefined): string {
  return v && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(v) ? v : DEFAULT_COLLECTION_COLOR;
}

/** Long replies are cut so the address stays within what browsers accept. */
const SEED_CONTENT_MAX = 3000;

/** Link to the new-article page, pre-filled from a seed. */
export function buildNewArticleHref(seed: ArticleDraftSeed = {}): string {
  const p = new URLSearchParams();
  if (seed.title) p.set('title', seed.title);
  if (seed.content) p.set('content', seed.content.slice(0, SEED_CONTENT_MAX));
  if (seed.language) p.set('language', seed.language);
  if (seed.kind) p.set('kind', seed.kind);
  if (seed.sourceConversationId) p.set('conv', seed.sourceConversationId);
  if (seed.resolvesGapId) p.set('gap', seed.resolvesGapId);
  const qs = p.toString();
  return qs ? `/knowledge/new?${qs}` : '/knowledge/new';
}

export interface ImportedDraft {
  id: string;
  title: string;
}

/**
 * The drafts an import created, read defensively from the API response
 * (`documents`, or a single `document`), so a small change in its shape
 * does not blank the result list.
 */
export function readImportedDrafts(data: unknown): ImportedDraft[] {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const list = Array.isArray(d.documents) ? d.documents : d.document ? [d.document] : [];
  const out: ImportedDraft[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { id, title } = item as Record<string, unknown>;
    if (typeof id === 'string' && id) out.push({ id, title: typeof title === 'string' && title ? title : id });
  }
  return out;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

/** File types the import accepts, by extension (mime types are unreliable
 *  for .md and .csv across browsers). */
export const IMPORT_EXTENSIONS = ['.txt', '.md', '.markdown', '.csv', '.docx', '.pdf'] as const;
export const IMPORT_MAX_BYTES = 10 * 1024 * 1024;

export function isImportableFile(name: string): boolean {
  const lower = name.toLowerCase();
  return IMPORT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/** http(s) only: what the server will fetch, checked early for a clear message. */
export function isHttpUrl(v: string): boolean {
  try {
    const u = new URL(v.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}
