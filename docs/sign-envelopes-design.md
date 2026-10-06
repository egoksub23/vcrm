# Doc Sign envelopes: several documents, one sitting (F-18, migration 171)

Status: built in WP16. Read with `docs/vircle-sign-features.md` (F-18) and `docs/doc-sign-setup.md`.

## The model

An **envelope** groups 2 to 6 ordinary documents for the SAME people. It is a thin layer over what already exists:

- Every document stays a normal `sign_documents` row: its own PDF, fields, form, answers, seal, certificate, audit chain and
  retention date. Nothing about a single document changes for anyone who never makes an envelope.
- `sign_envelopes` holds what is shared: title, reference (`ENV-2026-000012`), contact, message, expiry, code, signing order,
  language, reminders, sent and completed times, and a status that the database derives from its documents.
- `sign_documents.envelope_id` and `envelope_position` (1 to 6) are set when the draft is made and never change (a trigger holds it).
- `sign_signers.party_id` ties together the rows that are one PERSON across the documents. The person's row on their first
  document (lowest position) is the **anchor**: its `party_id` is its own id, and every other row of that person carries it.
  A person has at most one row per document (one person holding two roles on one document is refused in an envelope).

## One person, one link

Only the anchor row has a link token (`sign_signer_secrets`). `sign_invite_step` (now envelope aware) issues a token only for
anchors and gives back one invitation per person. The page behind the link loads the anchor, then every row whose `party_id`
equals the anchor's id (`lookupByToken` returns them as `lookup.party`). A sibling is therefore found only through the
person's own rows: a document the person is not a signer of can never appear, and two people of one envelope never see each
other's rows because their party ids differ. Asking for a document with `?doc=<id>` swaps in the person's row on that document
or answers 404 like any bad link.

The code is asked once (the cookie belongs to the anchor; the code is required when ANY of the person's documents requires it,
and the sender cannot make them differ: the send function refuses an envelope whose documents disagree on the code or the
signing order). The electronic-signing consent is asked once and recorded by `sign_envelope_record_consent` on every open row
of the person in ONE transaction: same version, same locale, same timestamp, so each document's certificate is complete.

## The signer's sitting

After the code and the consent the page shows "Document 1 of 3: {title}" and a list of the documents with the person's state
on each. The person goes through the documents in order using the existing screens (fields on the page, form in parts,
review, signature). They are not forked: the single-document page takes a `scope` (`<token>` or `<token>@<documentId>`) and an
`envelope` prop. On a document that is not the last one still to do, the button says "Next document"; it saves, runs the
server's own completeness check for that document (`complete` with `check`, which changes nothing) and moves on. On the last
one it says "Finish": the server completes each document's signer step IN ORDER (`/envelope/finish`).

Resumable and idempotent: answers autosave per document; reopening the link goes to the first document still to do. If
document 2 fails (an answer that does not fit, a closed document), document 1 stays signed, the answer names the document
and the page shows what remains with a retry. A document already signed is skipped, never signed twice.

Signing order, parallel steps, sensitive fields, form parts and form-only documents work as they do for one document. Order
numbers mean the same step on every document. A step of the envelope is complete when every row of that step on every document
is signed; only then is the next step invited, once, with one message listing the documents (`sign_complete_signer` takes the
envelope lock, marks the row, and skips the per-document next step for an envelope document; the envelope step does it).
Forwarding is not offered in an envelope (the document's switch is forced off and a trigger refuses it): a turn handed to
someone else would split one person's rows.

## What is sealed

Each document is sealed on its own by the existing job, with its own certificate. Each certificate gets one extra block, "Part of
envelope {reference}", listing the sibling documents by title, reference and the SHA-256 of the file AS SENT (that fingerprint
exists for every sibling from the moment of sending, so the block never depends on the order the documents were sealed in).
The block is optional data on the certificate (`CertificateData.envelope`) with its own small drawing function.
Each document's chain gets `envelope_sent` when the envelope is sent and `envelope_completed` when the last document is sealed.

The envelope is `completed` when every document is completed (derived by a trigger). The person and the sender then get ONE
email each with every signed PDF attached (attached up to 20 MB in total, the rest named with "open your link"); the combined
message is claimed once by `sign_envelope_settle`, so a retry or two sealing workers cannot send it twice. A document of an
envelope sends no completion email of its own.

## Sender side

"Send as envelope" starts at `/sign/new/envelope`: choose 2 to 6 active templates (or one uploaded file and templates), a title,
the contact and optional ticket or deal. The envelope page (`/sign/envelopes/<id>`) has the documents (each opens its normal
draft editor for fields and merge values; its own people, options and send steps are replaced by a note pointing back), the
shared signing list (each person is given a role on each document; conflicts are shown), options (one expiry, message, code,
language, reminders, signing order for all) and a review that lists every document's problems, then Send once.

- Limits: each document counts toward `sign_documents_per_month`; the whole envelope is refused when it does not fit
  (`signSendHeadroom`). At most 6 documents, 300 pages and 50 MB of frozen files in total.
- Remind, resend and change recipient act on the PERSON across all their documents (`sign_envelope_rotate_token`,
  `sign_envelope_change_recipient`), one message, one new link. The old link dies.
- Void: only while no document is fully signed (none in `sealing`, `completed` or `failed`). Then the whole envelope is voided
  in one step. After that, void, remind, resend and change recipient on a single document of an envelope are refused with a
  clear message; the people can still finish, or the envelope expires. A person who declines declines every document that is not
  yet fully signed.
- Expiry is one date; the sender can extend it for all documents together.
- Delete: a draft envelope deletes with its drafts; a completed one once every document's retention date has passed.

## Events and integrations

Each document keeps its normal events plus the two markers. Outbound events (`emitSignEvent`: webhook and automation trigger)
fire per document; the payload carries `envelope_id` (null for a single document). The automation step and the public API do
NOT create envelopes in this release (follow-up). The API's document resource shows `envelope_id`, read-only.

The verify page `/verify/<document id>` is unchanged; for a document of an envelope it adds "part of an envelope with N
documents" (the count only, never a sibling's title).

## Out of scope (documented follow-ups)

Creating envelopes from automations, the API or bulk send; adding or removing a document of a draft envelope after it was made
(delete the draft and make a new one); forwarding inside an envelope; mixing different signing orders or code settings between
documents; one combined PDF of all documents; completion emails for completed documents when the rest of the envelope ended
declined, expired or voided (they stay downloadable from the person's link).
