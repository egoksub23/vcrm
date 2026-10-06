---
title: How long signed documents are kept
description: A signed document is kept for a set number of years and cannot be deleted before then. Where you set the period, what it covers and what it does not.
order: 20
updated: 2026-10-07
---

A signed document is a record. Doc Sign keeps every completed document for a period you choose, called the **retention period**. Until the end of it, nobody can delete the document, not even the workspace owner.

## Before you start

Open **Settings**, then **Doc Sign**, then **General**. Changing the period needs permission to manage Doc Sign settings. Anyone who can see Doc Sign can see when a document is kept until.

## What is kept, and until when

When the last person signs and the document is sealed, Doc Sign works out its **retention date**: the day it was sealed plus the retention period. The date is shown on the document's page, under the green "Completed" banner, for example "Kept until 6 Oct 2033".

Until that date:

- The document, its signed PDF, the certificate pages and its history cannot be deleted by anyone: not by you, not by the workspace owner, not by an administrator.
- The retention date cannot be shortened. It can only be moved later.

After that date the rule no longer stops a deletion. Doc Sign never deletes anything by itself, and there is no button to delete a signed document yet.

## Set the period

1. In **Settings**, **Doc Sign**, **General**, find **Retention**.
2. Enter a whole number of years, from 1 to 50. The starting value is **7**.
3. Click **Save**.

> [!NOTE]
> 7 years is a starting value, not advice. How long you must keep signed records depends on the kind of document and on the laws and contracts that apply to your organisation. Ask your lawyer or auditor, then set the period to match.

A category can have its own period (see [Categories and add-ons](/help/doc-sign/categories-and-add-ons)). If a category has one, it is used for the documents of that category. If it is empty, the workspace period is used.

## What a change does to documents already signed

Nothing. The retention date is fixed on the day a document is sealed. If you change the period from 7 to 10 years today, documents sealed from now on are kept for 10 years, and documents already sealed keep the date they were given. Settings shows how many signed documents are already past their retention date.

## What is not covered

- **Drafts and documents that were never sealed.** A draft can be deleted by anyone who can send documents. A document that was sent but not completed (declined, expired or cancelled) is not deleted either; cancel it instead. See [Remind, resend and cancel](/help/doc-sign/remind-resend-and-cancel).
- **Copies outside Halo.** The signed PDF you or the signers downloaded or received by email is yours to keep or delete. Retention applies to the copy kept in Doc Sign.
- **Deleting your whole workspace.** This is the one exception. When a workspace is deleted, everything in it is removed, signed documents included, so export your workspace data first (the owner can do this in Settings, under the workspace's data and deletion options). Whether signed documents should outlive a deleted workspace is still to be decided together with legal advice; until then, they do not.

## Tips

- Decide the period before you send the first real document, so every document gets the right date from the start.
- Download the signed PDF and keep your own copy if the contract matters to you for longer than the period.

## Common mistakes

- **Expecting to delete a signed document to fix a mistake.** Signed documents are kept on purpose. Cancel a document that is still open, or send a new one.
- **Changing the period and expecting old documents to change.** Only documents sealed after the change use the new period.
- **Treating 7 years as a legal answer.** It is a starting value. Confirm the period for your own documents.

## Related pages

- [The audit trail and the sealed PDF](/help/doc-sign/audit-trail-and-sealed-pdf)
- [Settings and the WhatsApp template](/help/doc-sign/settings-and-whatsapp)
- [Categories and add-ons](/help/doc-sign/categories-and-add-ons)
