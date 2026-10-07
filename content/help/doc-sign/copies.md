---
title: Receive a copy of the signed document
description: Send the signed PDF to people who do not sign, such as a boss, an accountant or a customer's finance team, once the document is completed.
order: 28
updated: 2026-10-07
---

Some people need the final signed file but do not sign anything. A manager who wants it for the records, an accountant who files it, a customer's finance team. In Doc Sign they are people who **Receive a copy**.

When the document is completed and sealed, each of them gets **one email** with the signed PDF attached. That is all they get.

## Before you start

You need permission to send documents. A person who receives a copy needs only a **name** and an **email address**. They do not need a role, a field, a phone number or a place in the signing order.

## Add a person who receives a copy

**On a document you are preparing (a draft).**

1. Open the draft and go to the **People** step.
2. Add the person. Type their name; if they are in your contacts, choose the contact and the email is filled in (you can change it).
3. Set their type to **Receives a copy**.

**On a document collection you are preparing.** Open the collection, go to **People**, add the person and choose **Receives a copy**. A copy recipient belongs to the whole collection. The documents inside it do not take any of their own.

**After you have sent it.** You can still add or remove a person on the document page, or on the collection page, until the document is completed. Once it is completed, no one can be added: the copy has already gone out.

## What they get

- **One email, when the document is completed and sealed.** The signed PDF is attached. The sealed PDF already contains the certificate pages that record who signed and when, so the attachment is the proof. Nothing else needs to be sent.
- **For a collection, one email with all the signed PDFs.** The person does not get one email per document.
- **For a form without a signature, the sealed record of what was submitted.** Answers marked sensitive are masked in that record, as they always are. See [Forms without a signature](/help/doc-sign/forms-without-signature).

The email is written in the language of the document. It says who asked for it to be sent, and that the person was not asked to sign anything.

## What they never get

- A **signing link**. They cannot open the document, change it or sign it.
- The document **before it is completed**, or any news of how it is going.
- **Reminders.**
- A place in the count. They are not counted in "2 of 3 signed", and they never hold up a document.

## Limits

- Up to **10** people can receive a copy of one document or one collection.
- The same email address can be on the list **once**.
- A person who **signs** the document already gets the signed copy as a signer, so they cannot also be on the copy list.

## When the file is too large

An email can carry only so much. If a signed file is too large to attach (over 20 MB, and for a collection, over 20 MB in all), Halo does **not** send a download link, because anyone who held the link could open the file. Instead the email says that the signed copy is too large to attach and that they can ask the sender for it. It also gives the link to the public check page for the document. That page shows **no document**; it only says whether the file is genuine.

For a collection, the files are attached in order while they fit. The email says how many were attached, and names the ones that were not.

## Sent once

Each person is sent the copy **once**, even if the final step of the document runs again. If an email cannot be delivered, the failure is recorded in the document's history and that person keeps showing **Not sent yet** on the document page. Halo does not try again by itself, as for the signers' own copy, so send them the signed file yourself. An email that was delivered is never repeated.

## Change the list

You can add or remove people for as long as the document is open (a draft, sent or in progress). Each change is written in the document's **History** by the person's name, with the email address partly hidden. A collection records it on every one of its documents.

To change a person's name or email, remove them and add them again.

## From the API and from automations

- A system that sends documents through the API can pass `copy_to`, a list of up to 10 people with a `full_name` and an `email`. See [API and integrations](/help/doc-sign/api-and-integrations).
- In an automation, the step **Send document for signing** can add recipients who **Receive a copy**. See [Automate signing](/help/doc-sign/automate-signing).

## Common mistakes

- **Adding someone who must sign as a person who receives a copy.** They would have no link and could not sign. Set them to **Must sign**. A person who signs already gets the copy.
- **Expecting a link.** A person who receives a copy never gets one. If they need to read the document first, make them a signer.
- **Adding someone after the document is completed.** It is too late: the copies have already gone out. Download the signed file from the document page and send it to them yourself.
- **Expecting reminders or progress.** They hear nothing until the document is completed.
- **Adding a person to one document of a collection.** People who receive a copy belong to the collection. Add them on the collection page.

## Related pages

- [Send a document for signature](/help/doc-sign/send-a-document)
- [Document collections](/help/doc-sign/document-collections)
- [The audit trail and the sealed PDF](/help/doc-sign/audit-trail-and-sealed-pdf)
- [API and integrations](/help/doc-sign/api-and-integrations)
- [Automate signing](/help/doc-sign/automate-signing)
