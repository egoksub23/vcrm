---
title: How long signed documents are kept
description: A signed document is kept for a set number of years and cannot be deleted before then. Where you set the period, what it covers, how to delete it afterwards and what it does not cover.
order: 20
updated: 2026-10-17
---

A signed document is a record. Secure Sign keeps every completed document for a period you choose, called the **retention period**. Until the end of it, nobody can delete the document, not even the workspace owner.

## Before you start

Open **Settings**, then **Secure Sign**, then **General**. Changing the period needs permission to manage Secure Sign settings. Anyone who can see Secure Sign can see when a document is kept until.

## What is kept, and until when

When the last person signs and the document is sealed, Secure Sign works out its **retention date**: the day it was sealed plus the retention period. The date is shown on the document's page, under the green "Completed" banner, for example "Kept until 6 Oct 2033".

Until that date:

- The document, its signed PDF, the certificate pages and its history cannot be deleted by anyone: not by you, not by the workspace owner, not by an administrator.
- The retention date cannot be shortened. It can only be moved later.

After that date the rule no longer stops a deletion. Secure Sign never deletes anything by itself: a person with permission to manage Secure Sign settings can delete the document, as described below.

## Delete a signed document after its date

Once the retention date has passed, a **Delete** button appears at the top of the document's page, next to the download buttons. It is shown only to people who can manage Secure Sign settings, and only for a completed document (a completed document that was later cancelled counts too). Before the date, nothing new is shown: the page says the document is kept until that date.

1. Open the document from the Secure Sign list.
2. Click **Delete**.
3. Read the message. The signed PDF, the certificate and every signer's answers and uploads are removed for good. This cannot be undone and nothing can be recovered afterwards. The dialog shows the document's reference so you can be sure it is the right one. Download the signed copy first if you still need it.
4. Click **Delete permanently**.

You go back to the Secure Sign list and a message confirms what was deleted. If Secure Sign refuses (for example the retention date has not passed after all, or you do not have permission), the dialog shows the reason and nothing is deleted.

A **document collection** is deleted as a whole, from the collection's page, and only when every document in it is past its retention date. The button appears on the collection's page; deleting it removes all of its documents with their files. A document that belongs to a collection cannot be deleted on its own.

> [!WARNING]
> Deleting is permanent and cannot be undone from Secure Sign. Keep your own download if the record may matter later.

## Set the period

1. In **Settings**, **Secure Sign**, **General**, find **Retention**.
2. Enter a whole number of years, from 1 to 50. The starting value is **7**.
3. Click **Save**.

> [!NOTE]
> 7 years is a starting value, not advice. How long you must keep signed records depends on the kind of document and on the laws and contracts that apply to your organisation. Ask your lawyer or auditor, then set the period to match.

A category can have its own period (see [Categories and add-ons](/help/doc-sign/categories-and-add-ons)). If a category has one, it is used for the documents of that category. If it is empty, the workspace period is used.

## A cancelled document

A completed document that was later cancelled (see [Remind, resend and cancel](/help/doc-sign/remind-resend-and-cancel#cancel-a-completed-document)) is kept exactly like any other completed document. The retention period runs from the day it was completed, not from the day it was cancelled, cancelling does not shorten or restart it, and its signed PDF and certificate cannot be deleted before that date.

## What a change does to documents already signed

Nothing. The retention date is fixed on the day a document is sealed. If you change the period from 7 to 10 years today, documents sealed from now on are kept for 10 years, and documents already sealed keep the date they were given. Settings shows how many signed documents are already past their retention date.

## What is not covered

- **Drafts and documents that were never sealed.** A draft can be deleted by anyone who can send documents. A document that was sent but not completed (declined, expired or cancelled) is not deleted either; cancel it instead. See [Remind, resend and cancel](/help/doc-sign/remind-resend-and-cancel).
- **Copies outside Halo.** The signed PDF you or the signers downloaded or received by email is yours to keep or delete. Retention applies to the copy kept in Secure Sign.
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
