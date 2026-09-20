import { describe, expect, it } from 'vitest';

import type { KnowledgeDocSummary } from '@/lib/knowledge-types';

import {
  buildNewArticleHref,
  collectionIdOfView,
  collectionView,
  countDocs,
  docStatusOf,
  filterDocs,
  formatBytes,
  isHttpUrl,
  isImportableFile,
  isListView,
  isReviewDue,
  readImportedDrafts,
  safeHexColor,
} from './library-helpers';

const TODAY = '2026-09-20';

function doc(over: Partial<KnowledgeDocSummary>): KnowledgeDocSummary {
  return {
    id: 'd1',
    title: 'Refund policy',
    kind: 'article',
    language: 'en',
    status: 'published',
    use_in_ai: true,
    category: 'Billing',
    collection_id: 'c-billing',
    review_by: null,
    updated_at: '2026-09-01T00:00:00Z',
    created_by: 'u1',
    source_conversation_id: null,
    source_kind: null,
    ai_uses: 0,
    attachment_count: 0,
    ...over,
  };
}

const docs = [
  doc({ id: 'a', title: 'Refund policy' }),
  doc({ id: 'b', title: 'Pricing plans', category: 'Pricing', collection_id: 'c-pricing', review_by: '2026-09-20' }),
  doc({ id: 'c', title: 'Discount approvals', use_in_ai: false, collection_id: 'c-pricing', category: 'Pricing' }),
  doc({ id: 'd', title: 'Holiday hours', status: 'draft', language: 'ms', collection_id: null, category: null }),
  doc({ id: 'e', title: 'Old draft', status: 'draft', review_by: '2020-01-01' }),
];

const ids = (list: KnowledgeDocSummary[]) => list.map((d) => d.id);
const f = (over: Partial<Parameters<typeof filterDocs>[1]>) =>
  filterDocs(docs, { view: 'all', language: '', query: '', today: TODAY, ...over });

describe('review due and status', () => {
  it('is due on and after the date, only for published articles', () => {
    expect(isReviewDue({ status: 'published', review_by: '2026-09-20' }, TODAY)).toBe(true);
    expect(isReviewDue({ status: 'published', review_by: '2026-09-21' }, TODAY)).toBe(false);
    expect(isReviewDue({ status: 'published', review_by: null }, TODAY)).toBe(false);
    expect(isReviewDue({ status: 'draft', review_by: '2020-01-01' }, TODAY)).toBe(false);
  });

  it('shows draft before review due before published', () => {
    expect(docStatusOf({ status: 'draft', review_by: '2020-01-01' }, TODAY)).toBe('draft');
    expect(docStatusOf({ status: 'published', review_by: '2020-01-01' }, TODAY)).toBe('review');
    expect(docStatusOf({ status: 'published', review_by: null }, TODAY)).toBe('published');
  });
});

describe('filterDocs', () => {
  it('shows everything on All', () => {
    expect(ids(f({}))).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('filters by view', () => {
    expect(ids(f({ view: 'drafts' }))).toEqual(['d', 'e']);
    expect(ids(f({ view: 'review' }))).toEqual(['b']);
    expect(ids(f({ view: 'agents' }))).toEqual(['c']);
  });

  it('filters by collection', () => {
    expect(ids(f({ view: collectionView('c-pricing') }))).toEqual(['b', 'c']);
    expect(ids(f({ view: collectionView('nope') }))).toEqual([]);
  });

  it('filters by language and by title or collection text, case-insensitively', () => {
    expect(ids(f({ language: 'ms' }))).toEqual(['d']);
    expect(ids(f({ query: 'PRIC' }))).toEqual(['b', 'c']);
    expect(ids(f({ query: ' holiday ' }))).toEqual(['d']);
  });

  it('combines filters', () => {
    expect(ids(f({ view: 'drafts', query: 'old' }))).toEqual(['e']);
  });
});

describe('countDocs', () => {
  it('counts each rail entry', () => {
    expect(countDocs(docs, TODAY)).toEqual({
      all: 5,
      published: 3,
      drafts: 2,
      review: 1,
      agents: 1,
      byCollection: { 'c-billing': 2, 'c-pricing': 2 },
    });
  });
});

describe('views', () => {
  it('round-trips a collection id', () => {
    expect(collectionIdOfView(collectionView('abc'))).toBe('abc');
    expect(collectionIdOfView('drafts')).toBeNull();
  });

  it('knows which views list articles', () => {
    expect(isListView('all')).toBe(true);
    expect(isListView(collectionView('x'))).toBe(true);
    expect(isListView('gaps')).toBe(false);
    expect(isListView('insights')).toBe(false);
  });
});

describe('safeHexColor', () => {
  it('passes real hex colours and falls back otherwise', () => {
    expect(safeHexColor('#7C3AED')).toBe('#7C3AED');
    expect(safeHexColor('#abc')).toBe('#abc');
    expect(safeHexColor('red')).toBe('#7C3AED');
    expect(safeHexColor('#123456; background:url(x)')).toBe('#7C3AED');
    expect(safeHexColor(null)).toBe('#7C3AED');
  });
});

describe('buildNewArticleHref', () => {
  it('links to the bare page without a seed', () => {
    expect(buildNewArticleHref()).toBe('/knowledge/new');
  });

  it('carries the seed as query parameters', () => {
    const href = buildNewArticleHref({
      title: 'Do you support LINE?',
      kind: 'qa',
      sourceConversationId: 'conv-1',
      resolvesGapId: 'gap-1',
    });
    const p = new URL(href, 'http://x').searchParams;
    expect(p.get('title')).toBe('Do you support LINE?');
    expect(p.get('kind')).toBe('qa');
    expect(p.get('conv')).toBe('conv-1');
    expect(p.get('gap')).toBe('gap-1');
  });

  it('keeps awkward characters intact and caps very long content', () => {
    const href = buildNewArticleHref({ content: `a&b=c ${'x'.repeat(5000)}` });
    const content = new URL(href, 'http://x').searchParams.get('content')!;
    expect(content.startsWith('a&b=c x')).toBe(true);
    expect(content.length).toBe(3000);
  });
});

describe('readImportedDrafts', () => {
  it('reads a documents list', () => {
    expect(readImportedDrafts({ documents: [{ id: '1', title: 'A' }, { id: '2' }, { title: 'no id' }, null] })).toEqual([
      { id: '1', title: 'A' },
      { id: '2', title: '2' },
    ]);
  });

  it('reads a single document', () => {
    expect(readImportedDrafts({ document: { id: '9', title: 'Page' } })).toEqual([{ id: '9', title: 'Page' }]);
  });

  it('copes with junk', () => {
    expect(readImportedDrafts(null)).toEqual([]);
    expect(readImportedDrafts({ documents: 'x' })).toEqual([]);
  });
});

describe('import file and url checks', () => {
  it('formats sizes', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2 KB');
    expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB');
  });

  it('accepts the supported types by extension', () => {
    for (const n of ['a.txt', 'A.MD', 'x.markdown', 'q.csv', 'r.docx', 'z.PDF']) expect(isImportableFile(n)).toBe(true);
    for (const n of ['a.doc', 'b.pptx', 'c', 'd.exe']) expect(isImportableFile(n)).toBe(false);
  });

  it('accepts only http and https addresses', () => {
    expect(isHttpUrl('https://example.com/help')).toBe(true);
    expect(isHttpUrl(' http://example.com ')).toBe(true);
    expect(isHttpUrl('ftp://example.com')).toBe(false);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('example.com')).toBe(false);
  });
});
