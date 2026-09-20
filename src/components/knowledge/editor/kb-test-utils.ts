import type { KnowledgeTestPassage } from '@/lib/knowledge-types'

export type ArticleVerdict = 'used' | 'below' | 'missing'

/** Where does this article stand in a test result? `used` = at least one of
 *  its passages would reach the AI; `below` = it matched but only under the
 *  cut-off; `missing` = it did not come up at all. */
export function summariseTest(
  passages: KnowledgeTestPassage[],
  articleId: string | null,
): { thisArticle: ArticleVerdict; usedCount: number } {
  const usedCount = passages.filter((p) => p.used).length
  const mine = articleId ? passages.filter((p) => p.document_id === articleId) : []
  const thisArticle: ArticleVerdict = mine.some((p) => p.used) ? 'used' : mine.length > 0 ? 'below' : 'missing'
  return { thisArticle, usedCount }
}
