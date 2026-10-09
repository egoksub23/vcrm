---
title: Document collections, several documents in one sitting
description: Send two to six documents to the same people as one document collection, so each person gets one message, one link and signs everything in one visit.
order: 27
updated: 2026-10-07
---

A **document collection** is a group of two to six documents that go to the same people. Each person gets **one message and one link**, agrees to sign electronically **once**, and signs all their documents in one visit. This is useful for a set such as a contract, a fee schedule and a registration form.

Every document in a collection is still a normal document: it has its own file, fields, signed PDF, certificate and history. The collection only holds what is shared, the people and the options.

A collection has its own number, such as `COL-2026-000012`, shown on its page and on each document's certificate. Collections made before this numbering began carry numbers that start `ENV-`; they are unchanged and work exactly the same. A collection can also be [private](/help/doc-sign/private-documents), and then every document in it is.

## Before you start

You need permission to send documents. A collection holds **2 to 6 documents**, **300 pages** in all and **50 MB** in all. Each document counts toward your monthly limit of documents sent for signing, so a collection of four documents uses four. If the workspace does not have room for all of them, the collection is not sent and nothing is used.

## Make a document collection

1. Click **New document**, then under **What are you sending?** choose **Document collection**.
2. Add the documents: drop several files at once or choose them, tick templates, or both. Drag a document, or use the arrows, to put them in the order the people will see them.
3. Give the collection a title and, if you like, a contact, a ticket or a deal. Click **Create the collection**.
4. On the collection page, open **People** and add each person **once** (see below). Do this first, so the editor has the people to offer when you place signature blocks.
5. In **Signature blocks**, scroll through all the documents in one editor and place the blocks. The documents are listed on the right, so you can jump straight to any of them, and you pick the person a block is for on the left. When you place a signature block (or any field), you give it to one of the people who must sign.
6. In **Options**, set the signing order, the expiry, the reminders and whether a code is needed. These apply to every document of the collection.
7. Open **Review and send**. It lists, document by document, what still needs fixing. When it is clear, click **Send**.

All the documents are sent together or not at all. If one of them is not ready, nothing is sent and the review tells you which one.

## People: add each person once

In **People** you add a person with a **name** and an **email**, and you choose what they are:

- **Signature required** is a person who signs, or fills in, their part of the documents.
- **Receives a copy** is a person who does not sign but should get the signed documents. See [Receive a copy of the signed document](/help/doc-sign/copies).

If you type a name that is in your contacts, Halo offers the contact. Choosing it fills in the name and the email, and you can still edit the email. If the contact has no email, type it yourself.

You do **not** say what each person is on each document. That happens when you place a signature block, or any other field, on a document: you give it to one of the people who must sign. In the editor, these people appear in the **assign to** list and on the **Roles** tab, marked **from the collection's people**. They are locked there. To rename or remove a person, go back to the collection page.

A person who must sign signs **only the documents on which at least one field is given to them**. They get one message and one link for the whole collection, and the documents they have nothing to do on are simply not in their list.

**How many people.** A collection that has an uploaded file can have up to **6** people who must sign, because a document holds up to 6 roles. Otherwise the limit is **20**. People who receive a copy are counted separately, up to 10.

**Removing a person** who must sign takes the fields given to them off the uploaded documents. The screen asks you first.

### Match the template's roles

A document made from a template keeps the template's own roles, such as "merchant" and "director". Under the list of people, a short section called **Match the template's roles** lets you say which person has each role. It is filled in for you when a role has the same name as a person, or when there is one person and one role. It is not shown for uploaded files, which take their roles from the people.

## Signing order

If you switch on signing order, each person has a **step**. The next step is invited only when everyone in the step before has finished **all** the documents, and they are invited once, with one message each. See [Signing order](/help/doc-sign/signing-order).

## What the signer sees

The signer opens one link. They see the list of documents and their own state on each one. They agree once, then go through the documents one after another. They can open the other documents in any order, and nothing is final until they finish the last one. When they finish, every document they have left is signed in turn.

If a document needs something fixed, the page takes them to that document and shows what is missing; the ones already done stay done.

When everyone has signed, each person who signed gets **one email** with all the signed documents attached (or a link to download them if they are large). Each document is sealed on its own, with its own certificate. The certificate also names the collection and says how many documents it held.

People who **receive a copy** get **one email** as well, with all the signed PDFs attached. They never get a signing link. See [Receive a copy of the signed document](/help/doc-sign/copies).

## Follow a collection

- In the **Documents** list a collection is **one row**, marked with the number of documents. Its status is worked out from its documents. Click it to open the collection page.
- The collection page shows each document with its state, each person with their state on every document, and the actions below.
- A document that is part of a collection shows a box at the top with the other documents and a link to the collection. The actions that change people or timing are done on the collection, not on one document.
- Someone who opens the public check page of a signed document sees that it was signed in a document collection.

## Remind, resend, change and cancel

- **Remind** and **Resend** work per person. A resend gives them one new link, and the old link stops working.
- **Change recipient** replaces a person on all their documents at once. It is refused once that person has signed any of them.
- A person who **receives a copy** can be added or removed on the collection page until the collection is completed.
- **Give more time** sets one new expiry date for every document that is still open.
- **Cancel the collection** stops every document and tells the waiting people once. You can cancel only while no document has been signed by everyone yet. After that the collection can no longer be cancelled this way.
- **Cancel a completed collection.** Once every document is signed, the person who sent the collection, or an admin, can still cancel it as a whole with **Cancel document** on its page or in the list. It needs a reason, can notify everyone, and cancels **all** the documents in it together. The signed copies and certificates are not changed, and you can still download them, but the collection is marked **Cancelled** and is no longer in force. See [Remind, resend and cancel](/help/doc-sign/remind-resend-and-cancel#cancel-a-completed-document).
- If a person **declines**, every document that is not yet fully signed is declined, and the collection stops.
- You can delete a collection that is still a draft. One that was sent is cancelled instead, and a signed one is kept for its retention period. See [Retention](/help/doc-sign/retention).

> [!NOTE]
> A document of a collection cannot be forwarded to someone else, and a test document cannot be put in a collection. A collection cannot be made from the automation builder or the public API yet; you make it here.

## Common mistakes

- **Adding the same person twice, once for each document.** Add them once. In the editor, give their signature blocks to them. The same email address twice is refused.
- **Leaving a person who must sign with nothing to do.** A person with no field given to them on any document blocks **Send**. The review says so, document by document, with a link that opens the document. Give them a field, or remove them. A document with nobody to sign it is flagged the same way.
- **Giving one template role to two people.** A role on a document goes to one person. If two people must sign, the template needs two roles.
- **Adding a person who receives a copy as a person who must sign.** Choose **Receives a copy** for people who only need the final file. They get no link and nothing to sign.
- **Expecting to change the people after sending.** Once sent, use **Change recipient** for someone who has not signed anything. A person who must sign cannot be added to a sent collection. A person who receives a copy can still be added until the collection is completed.
- **Trying to cancel one document.** Cancel the whole collection. A single document of a collection cannot be cancelled or reminded on its own.
- **Choosing too many or too large documents.** Two to six documents, 300 pages and 50 MB is the limit. Split a bigger set into two collections.

## Related pages

- [Send a document for signature](/help/doc-sign/send-a-document)
- [Receive a copy of the signed document](/help/doc-sign/copies)
- [Signing order](/help/doc-sign/signing-order)
- [What the signer sees](/help/doc-sign/what-the-signer-sees)
- [Remind, resend and cancel](/help/doc-sign/remind-resend-and-cancel)
- [The audit trail and the sealed PDF](/help/doc-sign/audit-trail-and-sealed-pdf)
