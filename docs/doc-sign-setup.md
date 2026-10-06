# Doc Sign: setup for the operator

Doc Sign is Halo's electronic signing module. It is **off for every workspace** until you
turn it on. This page is what you do on the server, and in the Platform console, to switch it
on for a workspace and keep it running. What users do is in the User Guide (**Doc Sign**).

## 1. Before anything else

- **Migrations 157, 158 and 159** are applied (`supabase/migrations/157_sign_foundation.sql`,
  `158_sign_ceremony.sql`, `159_sign_notifications.sql`). The container does not run migrations; use the Supabase CLI as in
  the README. They create the `sign_*` tables, the private storage bucket `sign-documents`,
  and the two flags below (off for every workspace, old and new).
- **`NEXT_PUBLIC_SITE_URL`** is your public https address. Signers' links are built on it.
- **`RESEND_API_KEY`** is set. Invitations, reminders and signed copies go out by email.
  Without it a document can be sent but nobody is told (the document's page says so).
- **`ENCRYPTION_KEY`** is set (it already is for WhatsApp and Jira). Sealing certificates are
  stored encrypted with the key ring, and the **Re-encrypt now** job rewrites them after a key
  rotation (`docs/encryption-key-rotation.md`) like every other secret.
- **`AUTOMATION_CRON_SECRET`** is set (section 4).

## 2. Turn Doc Sign on for a workspace

Sign in as a platform operator and open **Platform**. Open the workspace and click **Edit**.
In the features list:

| Switch | What it does |
|---|---|
| **Doc Sign** (`sign`) | The Doc Sign menu, the pages, the routes and Settings > Doc Sign. Off removes every Doc Sign permission from every person in the workspace, so nothing is shown. Signer links stop answering (404). |
| **Doc Sign: Merchant Registration** (`sign_merchant`) | Lets the workspace install the Merchant Registration add-on from Settings > Doc Sign > Add-ons. Needs **Doc Sign** on as well. |

Also in that dialog, **Signing documents per month** is the monthly limit (empty means no
limit). The workspace's admins get a notice at 80 percent, and sending is refused at 100 percent
with a message telling them to contact support. Drafts do not count, only documents sent.
The workspace's file storage is covered by the existing storage meter.

A workspace owner or admin then finds **Doc Sign** in the sidebar and in Settings. Who may do
what inside is set in **Settings > Roles & permissions** (view, send, void, manage templates,
manage settings).

## 3. Word files: the converter

PDFs and images work with nothing extra. A Word file needs the converter, a locked-down
Gotenberg container that only the app can reach. In `.env.local` on the server:

```
COMPOSE_PROFILES=sign
SIGN_CONVERTER_URL=http://sign-converter:3000
```

Then redeploy (`docker compose --env-file .env.local up -d`). `docker compose --env-file
.env.local ps` should list `sign-converter` as `healthy`. The container needs about 1 GB of
memory while it converts and the image is large; sizes, limits and what it cannot do are in
`docs/docker.md` ("Doc Sign converter"). Without it, a Word upload says "Word conversion is
not available right now. Upload a PDF instead."

A Word file may not convert to more than 50 pages and gets 60 seconds. A PDF may have up to
200 pages. Both may be up to 25 MB.

## 4. The scheduled job

Doc Sign needs one job called every **minute**. It seals documents that everyone has signed,
expires documents past their date, and sends due reminders. Without it, completed documents
stay in **Finishing** and no reminders or expiries happen.

```cron
* * * * *   curl -fsS -H "x-cron-secret: $AUTOMATION_CRON_SECRET" https://YOUR-APP/api/sign/jobs-cron
```

It uses the same secret and header as the other jobs. It is listed in
`docs/automations-and-cron.md`, and the **Background jobs** card in the Platform console shows
**Doc Sign jobs** with the time of its last run. Late or Not running means the crontab line is
missing or wrong.

## 5. Chinese and Korean names on signed files

The fonts built into the signing engine cover English and Bahasa Melayu. A name or text in
Chinese or Korean is otherwise drawn as `?`, and the sender is warned before sending. To fix
that, put a font file with those characters on the server (for example Noto Sans CJK) and
set, in `.env.local`:

```
SIGN_CJK_FONT_PATH=/app/fonts/NotoSansCJK-Regular.ttc
```

The path is the one **inside the container**, so mount the file into it. This path has not been
proved with a real CJK font yet: try a signed test document before relying on it
(`docs/sign-dependencies.md`).

## 6. The sealing certificate

Every completed document is sealed with a digital signature. The first time a workspace
seals a document, Halo makes a **self-signed** certificate for that workspace, valid for five
years, and keeps it encrypted (table `sign_certificates`, key ring). Nothing to do for this.

What users see: PDF readers say the signer is not trusted. The seal still shows whether the
file was changed after signing, but the reader cannot check who made the certificate. The
workspace sees this under Settings > Doc Sign > Sealing certificate, with its date. A new one is made
the next time a document is sealed after it expires.

A certificate from a certificate authority (so readers show a valid signature) is a later
step: there is no screen or route to upload one yet.

## 7. Limits worth knowing

| Item | Limit |
|---|---|
| File | 25 MB; PDF up to 200 pages; Word up to 50 pages after conversion |
| People on one document | 20 |
| Roles on one document | 6 |
| Fields on one document | 300 |
| Expiry | 1 to 365 days (default 14, per workspace) |
| Reminders | up to five, each 1 to 60 days after the invitation |
| Verification code | 6 digits, 10 minutes, 5 tries, 5 codes an hour |
| Retention of signed files | 7 years by default (`sign_settings.retention_years`, set by the operator for now) |

## 8. Forms

A template can carry a **form**: parts, each assigned to a role, each a list of questions. The signer opens one link, fills their parts over as many sittings as they like (their answers are saved on the server as they go), reviews the document with the answers printed on it, and signs. A part can belong to a filler role, who completes it without signing. Answers can also fill the contact when the signer submits.

Needs migration `160_sign_forms.sql` (adds `sign_template_versions.form` and `sign_documents.form_snapshot`). Apply it before a template with a form is saved; templates and documents without a form do not depend on it.

| Item | Limit or behaviour |
|---|---|
| Kinds of file a signer may upload | PDF, JPEG and PNG, decided from the file's first bytes, never its name. A field can narrow the list. |
| Size of one uploaded file | 5 MB unless the field says otherwise, at most 10 MB |
| Files in one field | 1 unless the field says otherwise, at most 10 |
| Uploads on one document | 50 MB in total, all roles together |
| Parts, questions | 20 parts, 200 questions per form |

**Where uploaded files are kept.** In the private `sign-documents` bucket, under the document's own folder: `account-<workspace id>/<document id>/upload/<file id>-<name>`. Each upload is also a row in `sign_document_files` (kind `signer_upload`) with its SHA-256, and an entry in the answer to its question. The path never reaches a browser: the signer sees their own file through their link, and staff download it from the document (the download is recorded).

**Uploads are listed in the certificate, not appended.** The certificate pages carry one line for each upload (who, the file name, the first 16 characters of its SHA-256) and one for each removal. The files themselves are not added to the signed PDF; they stay in storage with their fingerprints.

**Write-back.** A question can be tied to a contact field (name, email, company or a custom field). After the signer has signed, the answers they typed or confirmed are written to the document's contact, in the same workspace only, and only when the value differs; a question set to "only if empty" never overwrites. Every change is an audit event (`writeback`) with the old and the new value, which is personal data and is kept in the audit trail only, never on the certificate. A write-back that fails is logged (`[sign] write-back`) and never undoes the signature. Answers the signer never confirmed are not written back.

**More time.** The sender can push the expiry of a document that is still open (`POST /api/sign/documents/[id]/expiry`): later than now and later than the current expiry, at most a year ahead. It is recorded as `expiry_extended`.

## 9. Troubleshooting

| What you see | Likely cause and fix |
|---|---|
| No **Doc Sign** in the sidebar or Settings | The **Doc Sign** switch is off for the workspace, or the person's role lacks the permission. Check Platform first. |
| Signer link says "This link is not valid" | The link was cut off, was replaced by a newer one (a reminder, resend or change of recipient replaces it), or Doc Sign is off or the workspace is suspended. |
| Documents stay in **Finishing** | The scheduled job is not running. Check the **Background jobs** card and the crontab. |
| Document shows "Could not finish" | Sealing failed. It is retried by itself; the server log has `[sign]` lines with the reason. Check the certificate and `ENCRYPTION_KEY`. |
| "Word conversion is not available right now" | `SIGN_CONVERTER_URL` is empty, or the container is not running or not healthy (section 3). |
| A Word file "took too long" or "could not be converted" | Ask for a PDF. Large or unusual files can fail; the converter keeps no state. |
| A signer cannot upload a file | It is not a PDF, JPEG or PNG, or it is over the field's limit (section 8), or the document has reached 50 MB of uploads. |
| Nobody receives invitations | `RESEND_API_KEY` is missing, or the mail is in spam. The document's page says when a message could not be delivered. |
| WhatsApp invitation not delivered | The workspace has no approved message template set in Settings > Doc Sign > General, or its WhatsApp channel is off. |
| Chinese or Korean text appears as `?` | No CJK font (section 5). |
| "Monthly limit reached" when sending | The workspace is at its **Signing documents per month** limit. Raise or clear it in Platform. |
| Add-on card says "Not available" | **Doc Sign: Merchant Registration** is off for the workspace (section 2). |
| PDF reader says the signature is not trusted | Expected with the self-signed certificate (section 6). |
