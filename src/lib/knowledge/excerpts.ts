import type { KnowledgeHit } from '@/lib/ai/knowledge'
import type { KnowledgeSource } from '@/lib/knowledge-types'

// ============================================================
// The prompt numbers its knowledge excerpts [1], [2] ... and the model cites
// them. One excerpt per ARTICLE (an article can match on several passages),
// so a citation maps straight to an article and the numbers the agent sees
// ("Based on 1 · Refunds 2 · Hours") are simply 1, 2, 3.
// ============================================================

/** A chunk starts with its article title (see ingestDocument); show the
 *  passage without repeating it. */
export function stripTitle(content: string, title: string): string {
  return content.startsWith(`${title}\n\n`) ? content.slice(title.length + 2) : content
}

export interface GroupedExcerpts {
  /** One text per article, in rank order; the model sees these numbered. */
  excerpts: string[]
  /** The article behind excerpt i + 1. */
  documents: { id: string; title: string }[]
}

export function groupHitsByArticle(hits: KnowledgeHit[]): GroupedExcerpts {
  const order: string[] = []
  const byDoc = new Map<string, { title: string; parts: string[] }>()
  for (const h of hits) {
    let entry = byDoc.get(h.documentId)
    if (!entry) {
      entry = { title: h.title, parts: [] }
      byDoc.set(h.documentId, entry)
      order.push(h.documentId)
      // The first passage keeps its title header so the model knows what the
      // excerpt is about; later passages of the same article do not repeat it.
      entry.parts.push(h.content)
    } else {
      entry.parts.push(stripTitle(h.content, h.title))
    }
  }
  return {
    excerpts: order.map((id) => byDoc.get(id)!.parts.join('\n\n')),
    documents: order.map((id) => ({ id, title: byDoc.get(id)!.title })),
  }
}

/** The articles a reply was based on, as the agent sees them ("Based on
 *  1 · Refunds"): `n` is the excerpt number the model cited it by. */
export function buildSources(articleIds: string[], documents: { id: string; title: string }[]): KnowledgeSource[] {
  const out: KnowledgeSource[] = []
  for (const id of articleIds) {
    const i = documents.findIndex((d) => d.id === id)
    if (i >= 0) out.push({ id, title: documents[i].title, n: i + 1 })
  }
  return out.sort((a, b) => a.n - b.n)
}
