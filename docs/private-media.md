# Private customer media

Customer files are not served from public URLs. Two storage buckets hold workspace files.

| Bucket | Public? | What lives there |
| --- | --- | --- |
| `chat-media` | **private** (after migration 146) | message media in both directions, widget uploads, ticket attachments, incident evidence |
| `public-assets` | public | knowledge-base images and attachments, workspace logos, WhatsApp template header samples |
| `avatars`, `flow-media` | public | profile pictures; media used by automation flows (unchanged) |

`public-assets` is for files whose job is to be fetched by anyone with the link: they go out in emails and
chat messages, and Meta fetches template headers on every send.

## How a private file is read

A stored URL such as `https://<project>.supabase.co/storage/v1/object/public/chat-media/account-<id>/...` is
now only an **identifier**: once the bucket is private it serves nothing. Every place that shows or forwards
one turns it into a short-lived signed link first.

| Who | How | Code |
| --- | --- | --- |
| A teammate in the dashboard | the browser signs it with their own session; the read policy lets a member sign only files in their own workspace folder (`account-<id>/`) | `src/lib/media/signed-urls.ts`, `src/hooks/use-signed-media-url.ts`, `use-media-blob-url.ts` |
| A chat-widget visitor | the widget asks `POST /api/widget/media-url`; the server signs only a file attached to a message in that visitor's own conversation | `src/app/api/widget/media-url/route.ts`, `widget/src/media-links.ts` |
| Meta / Messenger / Instagram | a link minted at send time, valid one hour; the stored `media_url` stays the identifier, so a resend signs a fresh one | `linkForPlatform` in `src/lib/whatsapp/send-message.ts` |
| An email attachment | the server reads the file by path, no link at all | `attachmentFile` in `send-message.ts` |
| API and webhook consumers | `GET /api/v1/conversations/{id}/messages` and the `message.received` webhook carry a link valid one hour | `src/app/api/v1/conversations/[id]/messages/route.ts`, `src/lib/widget/inbound.ts` |

The rule that protects workspaces from each other is `pathInAccount` (`src/lib/storage/media-urls.ts`): the
server never signs a path outside the asking workspace's `account-<id>/` folder, whoever asks.

Dashboard links last four hours (`VIEW_URL_TTL_SECONDS`); links handed to third parties last one hour
(`HANDOFF_URL_TTL_SECONDS`).

## Going live (order matters)

Migration 145 (the `public-assets` bucket) is additive and already safe to apply. Migration 146 makes
`chat-media` private and **breaks every image, voice note and attachment in an app that does not sign links**,
so it waits in `supabase/held/` until the new app is running.

1. Deploy the app (the VPS redeploy).
2. Copy the files that must stay public: `node scripts/move-public-assets.mjs` (dry run), then `--apply`.
   Needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. It copies, never deletes, and can be re-run.
3. Move `supabase/held/146_chat_media_private.sql` to `supabase/migrations/` and
   `supabase/held/verify-146-chat-media-private.sql` to `supabase/ci/`, then in
   `supabase/ci/verify-guard-catalog.sql` remove `'chat-media'` from `public_buckets`.
4. Verify against the live database in a rolled-back run (the verify script ends in `ROLLBACK-OK`), then
   `npx supabase db push --linked`.
5. Open the inbox, a ticket with an attachment and the chat widget, and confirm media loads.

Migration 146 refuses to run while a knowledge-base file, logo or template header sample has no copy in
`public-assets`; it rewrites the stored URLs of the files that moved (article HTML and its older versions,
sent emails, logos, template headers) and then flips the bucket.

### Rolling back

```sql
UPDATE storage.buckets SET public = TRUE WHERE id = 'chat-media';
```

Every link reverts to working as before (the app still signs, which is harmless on a public bucket).

### Things to know

- Images already delivered inside **old emails** that point at a knowledge-base file in `chat-media` stop
  loading after the flip (new emails use `public-assets` addresses).
- Knowledge-base articles written before the move keep working: their `chat-media` image addresses are
  accepted when they name the account's own folder and are rewritten to `public-assets` on save
  (`src/lib/knowledge-format.ts`).
- Migrations 023, 039 and 076 each set `chat-media` public. They run before 146 on a fresh database, so a
  replay ends private; do not add another migration that re-upserts the bucket as public.
- A long-open lightbox or a video playing past its link's expiry can fail until reopened.
