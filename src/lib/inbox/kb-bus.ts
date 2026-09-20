import type { KnowledgeSearchResult } from "@/lib/knowledge-types";

// The Knowledge tab lives in the right-hand column and the reply box lives
// in the thread: siblings in the inbox page with no shared parent state. A
// window event lets the tab hand an article to the composer without
// threading a callback through the whole page. The composer owns the
// channel, so it does the channel-specific formatting itself.

const INSERT_EVENT = "vircle:kb-insert";
const DRAFT_EVENT = "vircle:kb-draft";

/** Ask the reply box to insert an article (text plus its files). */
export function requestKbInsert(article: KnowledgeSearchResult): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<KnowledgeSearchResult>(INSERT_EVENT, { detail: article }));
}

/** Ask the reply box to draft a reply from one article with the AI. */
export function requestKbDraft(articleId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<string>(DRAFT_EVENT, { detail: articleId }));
}

export function onKbInsert(handler: (article: KnowledgeSearchResult) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<KnowledgeSearchResult>).detail);
  window.addEventListener(INSERT_EVENT, listener);
  return () => window.removeEventListener(INSERT_EVENT, listener);
}

export function onKbDraft(handler: (articleId: string) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<string>).detail);
  window.addEventListener(DRAFT_EVENT, listener);
  return () => window.removeEventListener(DRAFT_EVENT, listener);
}
