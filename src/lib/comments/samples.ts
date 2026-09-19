import type { SupabaseClient } from '@supabase/supabase-js'
import { ingestComment, type IncomingComment, type IncomingPost } from './ingest'

// ============================================================
// Sample comments, so the Comments inbox can be tried (and shown) before
// a Facebook, Instagram or TikTok account is connected. They are flagged
// is_test: replying, hiding and deleting them changes only our copy and
// never calls a provider. External ids all start with "test-".
// ============================================================

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

interface Sample {
  post: IncomingPost
  comments: IncomingComment[]
}

function samples(): Sample[] {
  return [
    {
      post: {
        provider: 'facebook',
        channelRefId: 'test-page',
        externalPostId: 'test-fb-post-1',
        message: 'Our new plans are live: WhatsApp, Instagram, Messenger and TikTok in one inbox.',
        permalinkUrl: 'https://www.facebook.com/',
        mediaType: 'link',
        postedAt: minutesAgo(60 * 26),
      },
      comments: [
        { externalCommentId: 'test-fb-c1', authorExternalId: 'test-psid-1', authorName: 'Aisyah Rahman', text: 'Berapa harga untuk 3 agent? Ada percubaan percuma?', providerCreatedAt: minutesAgo(12) },
        { externalCommentId: 'test-fb-c2', authorExternalId: 'test-psid-2', authorName: 'Daniel Lim', text: 'Does it support Instagram DMs as well?', providerCreatedAt: minutesAgo(95) },
        { externalCommentId: 'test-fb-c3', parentExternalId: 'test-fb-c2', direction: 'outbound', authorName: 'Your Page', text: 'Yes! Instagram DMs and comments both land in the same inbox.', providerCreatedAt: minutesAgo(80) },
      ],
    },
    {
      post: {
        provider: 'facebook',
        source: 'ad',
        channelRefId: 'test-page',
        externalPostId: 'test-fb-ad-1',
        message: 'Try Vircle free for 14 days. No credit card needed.',
        permalinkUrl: 'https://www.facebook.com/',
        mediaType: 'link',
        postedAt: minutesAgo(60 * 72),
      },
      comments: [
        { externalCommentId: 'test-fb-c4', authorExternalId: 'test-psid-3', authorName: '陈美玲', text: '这个可以试用吗？支持中文客服吗？', providerCreatedAt: minutesAgo(40) },
      ],
    },
    {
      post: {
        provider: 'instagram',
        channelRefId: 'test-ig',
        externalPostId: 'test-ig-post-1',
        message: 'Behind the scenes with our support team ☕',
        permalinkUrl: 'https://www.instagram.com/',
        mediaType: 'feed',
        postedAt: minutesAgo(60 * 30),
      },
      comments: [
        { externalCommentId: 'test-ig-c1', authorExternalId: 'test-igsid-1', authorName: 'jason.tan', authorUsername: 'jason.tan', text: 'Is there an API so we can connect our own system?', providerCreatedAt: minutesAgo(25) },
        { externalCommentId: 'test-ig-c2', authorExternalId: 'test-igsid-2', authorName: 'nadia_h', authorUsername: 'nadia_h', text: 'Love this! Where can I sign up?', providerCreatedAt: minutesAgo(180) },
      ],
    },
    {
      post: {
        provider: 'tiktok',
        channelRefId: 'test-tiktok',
        externalPostId: 'test-tt-video-1',
        message: '3 ways to reply to customers faster #smallbusiness #whatsapp',
        permalinkUrl: 'https://www.tiktok.com/',
        mediaType: 'video',
        postedAt: minutesAgo(60 * 20),
      },
      comments: [
        { externalCommentId: 'test-tt-c1', authorExternalId: 'test-tt-u1', authorName: 'Mei Ling', authorUsername: 'mei.ling', text: 'How much per month for a small shop?', providerCreatedAt: minutesAgo(8) },
        { externalCommentId: 'test-tt-c2', authorExternalId: 'test-tt-u2', authorName: 'Faiz', authorUsername: 'faiz_88', text: 'Boleh share link? Nak cuba.', providerCreatedAt: minutesAgo(55) },
        { externalCommentId: 'test-tt-c3', authorExternalId: 'test-tt-u3', authorName: 'free.followers.now', authorUsername: 'free.followers.now', text: 'FOLLOW ME for 10k free followers!!! link in bio', providerCreatedAt: minutesAgo(300) },
      ],
    },
  ]
}

/** Create (or refresh) the sample comments. Returns how many exist now. */
export async function createSampleComments(db: SupabaseClient, accountId: string): Promise<number> {
  let n = 0
  for (const s of samples()) {
    for (const c of s.comments) {
      const r = await ingestComment(db, accountId, s.post, { ...c, isTest: true })
      if (r) n++
    }
  }
  return n
}

/** Remove every sample post (and, by cascade, its comments). */
export async function clearSampleComments(db: SupabaseClient, accountId: string): Promise<void> {
  await db.from('comment_posts').delete().eq('account_id', accountId).like('external_post_id', 'test-%')
}
