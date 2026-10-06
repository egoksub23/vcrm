---
title: Send a document for signature
description: Start a document from a file or a template, set who signs, check it and send it.
order: 2
updated: 2026-10-08
---

This page walks through sending one document, from choosing the file to pressing **Send for signature**.

## Before you start

You need permission to send documents. If you start from a template, it must be **Active**. See [Templates](/help/doc-sign/templates).

## Start a document

1. Click **New document**. You can also start from a contact's page, which fills in the contact.
2. Choose how to start.
   - **Upload a file** takes a PDF, a Word file or an image (JPG or PNG), up to 25 MB.
   - **Use a template** starts from a saved template with its fields and roles already placed.
3. Optionally give it a title, a category and a contact. Without a title, the file name or template name is used.
4. Click **Create draft**.

A Word file is converted to a PDF first. You see every page of the result before you send, and that PDF is exactly what the signers sign. If the conversion is not available on your server, or the file is too long, upload a PDF instead.

> [!NOTE]
> A file with a password, a Word file with macros, or a damaged file is refused with a message that says why. Remove the protection or save it as a plain PDF and try again.

## Prepare it in four steps

The draft opens in a workspace with four steps along the top. Your work is saved as you go.

1. **Fields** shows the pages. Place the fields people have to fill in or sign, and give each to a role. See [Prepare the fields](/help/doc-sign/prepare-fields). When you started from a template this is done already; check it.
2. **People** is the signing list: who signs or fills in. Add each person with their name, email, role and how to reach them (email or WhatsApp). You can add a person straight from your contacts. See [Signing order](/help/doc-sign/signing-order).
3. **Options** sets the title, category, contact, an optional **ticket** and **deal** to attach the document to, the language of the invitation, a message to the signers, the expiry date, the reminders, and whether each signer needs a verification code. Anything you leave alone follows the category and then the workspace settings.
4. **Review** shows everything in one place. If something is missing, it lists what to fix and takes you to the right step.

## Attach it to a ticket or a deal

On the Options step (and when you start a document) you can link it to a **ticket** or a **deal**. With a contact chosen, only that contact's tickets and deals are offered; without one, choosing a ticket or deal fills in its contact. A ticket and a deal must belong to the document's contact, so changing the contact detaches them.

The document then shows under **Documents** on that ticket page and in that deal's panel (open the deal from the pipeline), with its status and a link, and on the contact's **Documents** tab. Both pages have a **Send a document** button that opens a new document already attached.

## Send

When the review says everything is in place, click **Send for signature**. The first person (or everyone, if there is no order) gets an email or WhatsApp message with their private link.

> [!IMPORTANT]
> Once sent, the file and the signing order cannot be changed. To change them, cancel the document and send a new one.

## Verification code

If you tick **Needs a verification code** on the Options step, each signer must enter a 6-digit code before the document opens. The code goes to the address the document was sent to, works for 10 minutes and allows five tries. It is off unless you tick it, or unless the category turns it on for you.

## Tips

- Check the email address of each person twice. A wrong address means the link goes to someone else.
- Use the message box to say why you are sending it and what you need from them.
- If a document you often send has the same fields, [save it as a template](/help/doc-sign/templates#save-a-prepared-document-as-a-template).
- Uploaded the wrong file? On a draft you can [replace the file](/help/doc-sign/prepare-fields#replace-the-file-of-a-draft) and keep your fields.

## Common mistakes

- **Choosing WhatsApp before it is set up.** WhatsApp needs an approved message template. If none is set, the person is not reached. See [Settings and the WhatsApp template](/help/doc-sign/settings-and-whatsapp).
- **Putting the same email address on the list twice when signing order is on.** Each signer must then be a different person.

## Related pages

- [Prepare the fields](/help/doc-sign/prepare-fields)
- [Signing order](/help/doc-sign/signing-order)
- [What the signer sees](/help/doc-sign/what-the-signer-sees)
