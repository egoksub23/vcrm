---
title: Private documents
description: Keep a document or a document collection to yourself, your admins and the people named as signers, so nobody else with Doc Sign can find it.
order: 29
updated: 2026-10-08
---

Most documents in Doc Sign can be seen by everyone who has access to the Doc Sign menu. A **private** document is different: only a few people can see it, and nobody else can even find it. Use it for a contract, an offer or an HR document that the rest of the team does not need to read.

## Who can see a private document

- **The person who uploaded it.**
- **The workspace's admins and owners.**
- **Halo users who are named as signers on it.** A colleague who signs inside Halo can open the document they have to sign, and see how far it has got.

Everyone else with Doc Sign does not see it. It is not in the **Documents** list, not in a search, not in the counts above the list, not in the CSV export, not in the zip of signed documents, not in **Needs attention**, not on a contact's page and not in the public API. If they open its address, they get the same "not found" page as for a document that does not exist.

"See it" means everything about it: the document, who has signed, the answers on a form, the history, the files people uploaded and the people who receive a copy.

## Make a document private

1. Click **New document**. On the first step, **Documents**, turn on **Private document**. For a document collection the switch reads **Private document collection**.
2. Carry on as usual. You can change your mind on the same step while the document is still a draft.

Only the person who uploaded the document, or an admin, can change this switch. Anyone else sees it as it is, with a note saying why.

Once the document has been **sent**, the switch is locked. A private document stays private, and a document that was not private cannot be made private afterwards.

A lock mark next to the reference in the list, and a **Private** label on the document's page, tell you which documents are private.

## Document collections

The collection decides. When a collection is private, **every document in it is private**. A Halo user named as a signer on any document of a private collection can see the collection and all of its documents, because the same people sign them all in one sitting. A private document cannot be added to a collection that is not private.

## What stays the same

- **People who sign from a link** open their document exactly as before. Privacy is about who can see it inside Halo, not about the signer.
- **Documents made by a bulk send, a registration form or an automation** are never private.
- **The public API** never lists or opens a private document. A key belongs to an integration, not to a person, so it cannot be named on a document.
- **The page that checks a signed file** (the link on the certificate) works for anyone who has the signed file, private or not.
- **A Halo user who is only named as a signer** can read a private draft but cannot change, send or delete it. Only the uploader and the admins edit it.

## Common mistakes

- **Expecting a colleague to see it.** A colleague who is not named as a signer will not find it. Name them as a signer, or ask an admin.
- **Marking it private after sending.** The switch is chosen while the document is a draft. After sending it cannot change.
- **Expecting a private document to be hidden from admins.** Admins and owners can always see it.
- **Using private instead of permissions.** Private hides one document. To limit what a whole role can do, change the role's permissions in **Settings**. See [Roles and permissions](/help/getting-started/roles-and-permissions).

See also [Send a document for signature](/help/doc-sign/send-a-document), [Document collections](/help/doc-sign/document-collections) and [Sensitive fields](/help/doc-sign/sensitive-fields).
