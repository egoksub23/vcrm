---
title: Forms in parts
description: Send a form the signer fills in over several sittings, follow how far they have got, remind them about what is left, and extend the expiry.
order: 11
updated: 2026-10-06
---

Some documents need more than a signature. A merchant application, for example, asks for company details, an address, tax details, a bank account and some files. A **form in parts** lets the signer fill all of that in on their phone, a little at a time, and then sign. You see how far they have got without asking them.

## What a form is

A form belongs to a [template](/help/doc-sign/templates). It is a list of **parts**, such as "Company and tax" or "Bank account", and each part has its own questions. When you start a document from that template, the form comes with it.

- **Asking and printing are separate.** Each question is asked once. Its answer can be printed in one place on the document, in several places, or not at all (kept only as data).
- **Each part has a role.** A part is completed by one role, for example the merchant or the finance team. A role either **signs** or only **fills in** (it never reaches the signing step).
- **Some questions appear only when they should.** A tax percentage, for example, is asked only when the tax type needs one. An answer that a rule hides is ignored.
- **Different terms are different templates.** If another group of merchants has other fees or clauses, use another template for them. A document always uses the form and the terms of the template version it was started from. A later change to the template never alters a document that was already sent.

> [!NOTE]
> The form is made and changed on the template, by someone who may manage templates. You cannot change it on a document you are preparing.

## Prepare and send

Start a document from the template as usual. See [Send a document for signature](/help/doc-sign/send-a-document). Three of the steps behave a little differently when the template has a form.

1. **Signature blocks.** The form's summary is in the header of its document in the scroll (open **Document options**): the parts, who completes each one (shown with the role's colour and name) and how many questions each has. A note reminds you that the form belongs to the template. If the template prints answers on pages, its pages are in the scroll with the other documents, and **Edit fields** lets you move where the answers are printed. It never changes the form. A form with nothing printed has no pages: it is a small card in the sequence and a line in the document list on the right.
2. **People.** Each role is listed with what it holds, for example "Merchant: parts 1 to 4 and signs" and "Finance: part 5, fills in only". Add a person for every role. A role that has parts but nobody assigned stops you from sending, and the page says which role needs someone.
3. **Review.** You see the parts and roles again. If any question fills from a contact (name, email, company or a custom field) and you linked a contact in the options step, the page says the form will start with the contact's details. If the form uses contact details but you did not link a contact, the page warns you that the signer will fill everything in themselves.

The result screen after sending is the same as for any other document.

## How the signer fills it in

Each person gets one private link. It opens an overview of their own parts, each marked **Not started**, **In progress** or **Done**, with a percentage. They can do the parts in any order and over several sittings.

- Every answer is **saved on our side as they go**. They can close the page, switch phones, and come back through the **same link**. If you turned on a verification code, they may be asked for a new code after a while.
- Details taken from the contact are shown to the signer to confirm. Until they confirm them, they are marked as not yet confirmed.
- **Review and sign** opens only when every required question in their parts is answered. They then see the real document with their answers printed on it, and sign. We check everything again when the signature arrives, so it cannot be skipped.
- If an answer is too long for the place where it prints, the signer is told which answer to shorten before they can sign.
- A person whose role only fills in does not sign. They finish their parts and are done.

For what the signer sees step by step, see [What the signer sees](/help/doc-sign/what-the-signer-sees).

## Follow the progress

Open the document from **Secure Sign**, then **Documents**. A document with a form opens on the **Progress** tab. It refreshes by itself every few seconds while the document is open.

For each person you see:

- Their name, role and status, a bar, and "3 of 7 parts done" with the share of required answers given.
- Each part with its state: **Not started**, **In progress** (with a count such as "4 of 6") or **Done**, and when it was last saved.
- When they were last active, and from what kind of device, for example "2 hours ago from a phone". If we cannot tell the device, we say only when.

Below that are **the answers so far**, grouped by part. They are read only and shown the way the signer typed them: choices by their label, lists one item to a line, files by name and size with a **Download** button, and pictures as small previews. A detail from the contact that the signer has not confirmed yet is marked **From the contact, not yet confirmed**. Downloading a file is written in the history.

If an answer will not fit where it prints, a warning at the top of the page names it.

> [!IMPORTANT]
> Answers can hold personal and financial details. You see them only if your role may see Secure Sign. Do not copy them into messages or tickets unless you need to.

## Remind about unfinished parts

On the Progress tab, click **Remind about unfinished parts** under the person. The confirmation lists the parts that will be named. The message tells them how many parts are left, names them and gives them a new link. The earlier link stops working.

A person can be reminded again only after a day. The button says when. Reminding needs permission to send. The **Remind** button on the **People** tab does the same thing.

## Extend the expiry

If the document will expire before they finish, click **Extend expiry**, choose a day after the current expiry and confirm. People can sign until the end of that day. You can extend only while the document is open (not yet signed by everyone, declined, cancelled or expired), and it needs permission to send. The new date is written in the history.

## Details that update the contact

When a signer signs, answers that are linked to a contact field update the contact, for example the name, email, company or a custom field. A question can be set to fill the contact always, or only when that contact field is empty. Only answers the signer confirmed are written. The history says that the contact was updated, which fields changed and links to the contact. It shows that a field changed, not the old and new values. Those are kept in the audit trail. See [The audit trail and the sealed PDF](/help/doc-sign/audit-trail-and-sealed-pdf).

## Tips

- Check the Review step before sending: it tells you whether the form will start with the contact's details.
- Add a person for every role before you send. Parts with nobody to complete them cannot be sent.
- Look at the Progress tab before you remind someone. It shows whether they have started, so your message can be a friendly nudge or a question.
- Use a separate template for each set of fees or terms.

## Common mistakes

- **Expecting to edit the form on the document.** The form belongs to the template. Change the template and send a new document.
- **Forgetting to link the contact.** The form is then empty and the signer types everything.
- **Sending the same link on to someone else.** A link is for one person. Change the recipient so the new person gets their own link. See [Remind, resend and cancel](/help/doc-sign/remind-resend-and-cancel).

## Related pages

- [Templates](/help/doc-sign/templates)
- [Send a document for signature](/help/doc-sign/send-a-document)
- [What the signer sees](/help/doc-sign/what-the-signer-sees)
- [Remind, resend and cancel](/help/doc-sign/remind-resend-and-cancel)
- [Prepare the fields](/help/doc-sign/prepare-fields)
