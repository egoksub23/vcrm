---
title: API and integrations
description: Let your own system send documents for signature, follow them and fetch the signed copy, using an API key with Doc Sign permissions.
order: 14
updated: 2026-10-07
---

If you have a system of your own, such as a merchant onboarding app, it can send documents for signature without anyone opening Doc Sign. It talks to Halo through the **API**. Your developer does the connecting; this page explains what you need to set up and what to expect.

## What the API can do

- List the templates you can send from.
- Send a document made from a template, to one or more people, in one step. The same call can name people who only **receive a copy** of the signed document (`copy_to`, up to 10, each with a name and an email).
- Check where a document stands and who has signed.
- Remind people who have not signed yet.
- Cancel a document that has not finished.
- Download the signed PDF once everyone has signed.

It cannot create or edit templates, and it does not give your system the signing links. People always get their link by email or WhatsApp, the same as when you send from the screen.

## Before you start

Ask your admin to check that **Doc Sign** is switched on for your workspace. If it is off, every call from your system is refused with the message that Doc Sign is not turned on.

## Create a key with the right permissions

1. Open **Settings**, then **API keys**, then **New API key**. Only admins and owners can do this.
2. Name the key after the system that will use it, for example "Merchant onboarding".
3. Tick the permissions it needs:
   - **sign:read** lets it see templates and documents and download signed copies.
   - **sign:write** lets it send documents, send reminders and cancel documents.
   A system that only needs to fetch signed copies needs only **sign:read**.
4. Create the key and copy it. **It is shown only once.** Give it to your developer through a safe channel, not by chat or email.

You cannot add a permission to a key later. Make a new key and revoke the old one from the same screen.

## What your developer needs to know

- **Templates first.** The templates list tells your developer each template's roles (for example "merchant" and "director") and the values the sender can fill in. Documents are sent to people by role.
- **Use a reference.** Your system should give each document its own reference, such as your merchant number. If the same call is made twice by mistake, Halo returns the first document and does not send a second one. Without a reference, a repeated call sends a second document.
- **The reference is the document number.** It is the number shown on the document and on the certificate, so choose something you recognise.
- **People who only receive a copy.** Pass them in `copy_to`. They get the signed PDF by email when the document is completed, never a link, and they are never in the list of signers. The API gives their names back, not their emails. They are part of the same call, so a repeated call with the same reference does not add them twice. See [Receive a copy of the signed document](/help/doc-sign/copies).
- **Reminders keep the 24-hour rule.** The same person cannot be reminded again within 24 hours.
- **The signed copy comes only after completion.** Before everyone has signed, the download is refused.
- **Use events instead of checking again and again.** Your system can be told when a document is signed, declined or expires, instead of asking every few minutes.

The full technical reference, with examples, is in the Public API document your developer has access to (the "Doc Sign" part).

## What you see in Halo

A document sent by your system appears in **Doc Sign**, **Documents**, like any other. Its **History** shows that the person who made the key started it. The monthly limit of documents for signature counts these documents too.

## Tips

- Make one key for each system, so you can revoke one without stopping the others.
- Test with a template and your own email address before connecting real customers.
- If your system sends by WhatsApp, check the approved message template in [Settings and WhatsApp](/help/doc-sign/settings-and-whatsapp) first.

## Common mistakes

- **Giving the key every permission "just in case".** Give only what the system needs.
- **Sending without a reference.** A retry after a timeout then sends the customer a second document.
- **Expecting the API to return the signing link.** It never does. Use a reminder if a message did not arrive.
- **Asking for the signed copy too early.** It exists only after everyone has signed and the document shows as completed.
- **Pasting the key into a shared document or a chat.** If that happens, revoke it and make a new one.

## Related pages

- [Send a document for signature](/help/doc-sign/send-a-document)
- [Receive a copy of the signed document](/help/doc-sign/copies)
- [Remind, resend and cancel](/help/doc-sign/remind-resend-and-cancel)
- [The audit trail and the sealed PDF](/help/doc-sign/audit-trail-and-sealed-pdf)
- [Templates](/help/doc-sign/templates)
