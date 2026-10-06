---
title: Send yourself a test
description: Try a template before a real person does. A test document is clearly marked TEST, goes only to you, and does not count toward your monthly limit.
order: 26
updated: 2026-10-08
---

Before you send a template to a merchant, you want to see what they will see: the email, the signing page, the signed file. **Send a test** does that. It makes a document from the template, marks it **TEST** everywhere, and sends it to you.

## Send a test

1. Open the template (**Doc Sign**, then **Templates**, then the template's name).
2. Click **Send a test**.
3. Check the address. It is your own email. Leave it as it is, or see "Use another inbox of yours" below.
4. Click **Send the test**.

You get the same email a signer gets, with **[TEST]** in front of the title. Open it and sign as the signer would. You can also open the document in Halo, find it under **Awaiting my signature**, and sign from there without leaving Halo.

You can test a template that is still a **Draft**. You do not have to make it active first.

> [!NOTE]
> The test is made from the template's **saved version**. If you changed the template and have not saved a version, the dialog says so. Save a version first if you want your latest changes in the test.

## What makes it a test

- **TEST on every page.** A large faint TEST across each page and a line along the top. The certificate pages of the signed file carry it too. A test can never be mistaken for a real agreement once it is printed or forwarded.
- **TEST in the messages and on the signing page.** The email subject and body say **[TEST]**, and the signing page has a red band that says it is a test.
- **Not counted.** A test does not count toward your **documents per month** limit, and you can send one even when you are at the limit.
- **Kept quiet.** No webhook and no automation hears about a test.
- **Kept for 30 days.** After it is signed, a test is kept for 30 days, then you can delete it like any other signed document.
- **Marked in the list.** It shows a red **Test** label in the documents list, and there is a **Test** filter above the list (it appears once you have one). The CSV export leaves tests out unless that filter is the one you export.

A test uses the template's real version and its real form, so you can try the whole thing: fill the parts, upload a file, sign, and read the sealed copy.

## Who the test goes to

Only to you. Doc Sign checks this on its server: the address must be the one you sign in with, or the same address with **+something** added before the @. A different person's address is refused.

### Use another inbox of yours

If a template has more than one role (a merchant and a director, say), you can play every role yourself. By default each role gets your address. If the template **signs in order**, one address cannot hold two places in order, so the test **ignores the order** and says so.

To try the order too, give each role its own address that is still yours: **you+merchant@company.com** and **you+director@company.com**. Most email providers (Gmail, Microsoft 365, Zoho) deliver both to your normal inbox.

## What a test is not

- It is not a way to send a document to a colleague. Use a normal document for that.
- It is not created by bulk send or the public API. Those only make real documents.
- It does not appear in the public API's list of documents, and it is not part of "Needs attention".

## Tips

- Test on your phone as well: open the email there and sign with your finger.
- If the template is for a form without a signature, the test is a form you fill in and submit.

## Common mistakes

- **Sending a test to a colleague's address.** It is refused. Make a real document instead.
- **Testing before saving a version.** The test shows the last saved version, not what is on your screen.
- **Looking for the test in "Awaiting my signature" and not finding it.** It shows there while it is waiting for you. Once you have signed every place it is no longer waiting.

## Related pages

- [Templates](/help/doc-sign/templates)
- [Send a document for signature](/help/doc-sign/send-a-document)
- [What the signer sees](/help/doc-sign/what-the-signer-sees)
- [Signing order](/help/doc-sign/signing-order)
