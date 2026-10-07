---
title: Forms without a signature
description: Send a form that someone only fills in and submits, for example the e-invoice and tax details of a merchant who already signed their agreement. Nothing is signed; you get a sealed record of what was submitted.
order: 25
updated: 2026-10-07
---

Not everything needs a signature. A merchant who signed their agreement last year still has to give you their **e-invoice and tax details**: the TIN, the MSIC code, whether they are registered for SST, an extract from SSM. You want them to fill it in on their phone, in their own time, and you want a record of what they sent.

A **form without a signature** does exactly that. It is the same [form in parts](/help/doc-sign/forms-in-parts), the same single link, the same one-time code if you ask for it, and the same [sealed record with a certificate](/help/doc-sign/sealing-certificate). The only difference is that nobody is asked to sign.

## Make the template

You need permission to manage templates (owners and admins have it by default).

1. Open **Secure Sign > Templates** and click **New template**.
2. Choose **Form without a signature**. There is no file to upload. Give it a name, such as "E-invoice and tax details", and click **Create**. The choice is made once: a template is an agreement to sign or a form, for good. To change your mind, make another template.
3. The form builder opens. Add the **parts** and the **questions** the same way as for any [form in parts](/help/doc-sign/forms-in-parts): text, choices, dates, files, "Is your company registered for SST?", and questions that appear only when they should. Mark a question **sensitive** if it holds something private, such as a TIN: it is kept encrypted and shown masked to your team ([sensitive fields](/help/doc-sign/sensitive-fields)).
4. Open **People who fill this in** above the parts. The template starts with one person, "Applicant". Add another if a second person completes some of the form, for example your merchant's accounts person. Give each part to one of them in the part's settings.
5. Click **Save**, then **Make active** in the template library. A form with no part cannot be made active.

> [!NOTE]
> A form without a signature has no page to place things on. The page editor, signature fields and "who signs" do not exist for it, and the form builder refuses a signature if one is added another way.

## Send it

Send it like any document: **New document > Use a template**, choose your form template, then:

1. **Form.** You see the parts and who completes each. You cannot change the form on a document, only on the template.
2. **People.** Add the people who fill it in. The wording says "people who fill this in", not "who sign". If someone is already a contact, add them **From contacts**.
3. **Options.** Set the expiry, the reminders, a one-time code if you want one, and the language. The email and the page use that language.
4. **Review.** Click **Send the form**.

Each person gets an email: "Please complete your details". The same works from a [bulk send](/help/doc-sign/bulk-send-and-export), an [automation](/help/doc-sign/automate-signing), the [public API](/help/doc-sign/api-and-integrations) and a [registration page](/help/doc-sign/registration-form): they all start a document from the template, and the document is a form because the template is.

A form counts as **one document sent** toward your monthly limit, the same as an agreement.

## What the person sees

1. **Agree to submit.** A short wording, "I agree to use electronic records to submit this form." You can write your own in **Settings > Secure Sign**; if you do, it is used for forms too. Their agreement is recorded with the time, the address and the device.
2. **A code**, if you asked for one.
3. **The parts.** They open them in any order, over as many sittings as they need. Everything is saved as they go, and the same link brings them back. Contact details Halo already has start filled in for them to check.
4. **Review and submit.** Every answer, part by part, with **Change** next to each part. A private answer is shown hidden. They press **Submit**.
5. **Thank you, your details were sent.** Nothing more to do. When everyone has submitted, they get an email with the record attached.

There is no document to read first, because there is nothing to sign.

## What you get

- **A sealed record.** When the last person submits, Halo makes a PDF: the title, who submitted and when, every answer by part in the form's language, the files they uploaded with their fingerprints, and the fingerprint of the audit trail. Then the certificate pages are added, the same QR code and **Check this document** page as for a signed agreement, and the whole file is sealed. A change to any page afterwards shows.
- **Private answers stay private.** A sensitive answer is printed only as a mask, such as `**** 4567`. The full value stays encrypted in Halo.
- **The status is Completed.** The history says "submitted", not "signed". The **Record** tab shows the sealed file, and **Download the record** saves it. It is kept for the same retention period as any signed document, and nobody can delete it before then.
- **The contact is updated.** If a question is set to fill a contact field (name, email, company or one of your custom fields), the confirmed answers are written to the contact when the person submits. The history shows what was updated, never the values.
- **A message to you.** You are told in Halo and by email when it is submitted, with the record attached.

## Common mistakes

- **Looking for the signature fields.** A form without a signature has none, and that is the point. If you need a signature, make an agreement from a file.
- **Switching an agreement into a form.** It cannot be done. Make a new template. You can copy the questions by saving a document as a template, or by duplicating a form template.
- **Forgetting a person for a part.** Every part needs someone. The review step says which part has nobody.
- **Sending a form to a registration page that expects an agreement.** A registration form sends one kind or the other. Choosing a template of the other kind switches the form's kind with it; if the two disagree, Halo says so and will not switch the page on.
- **Expecting the answers in the CSV export or the API data.** They are not there. The record is the way to get what was submitted: it is a PDF with every answer, and an integration can download it from the public API like any signed file.
