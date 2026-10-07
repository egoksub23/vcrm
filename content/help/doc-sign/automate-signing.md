---
title: Automate signing
description: Send a document automatically when a contact is tagged, and follow up when it is signed. The merchant onboarding example from start to finish.
order: 15
updated: 2026-10-07
---

Automations can send a document for signature on their own, and can react when a document is sent, opened, signed, declined, expired or cancelled. This page builds the merchant onboarding example from start to finish: a contact is tagged as a merchant applicant, the application goes to them, and when it is signed your team is told and the merchant gets a thank-you.

## What you need first

- Secure Sign is switched on for your workspace, and you can see **Secure Sign** in the menu.
- The **Merchant Application** template is installed and **Active**. See [Categories and add-ons](/help/doc-sign/categories-and-add-ons) and [Templates](/help/doc-sign/templates). Any other active template works the same way.
- A tag called **Merchant applicant** and a tag called **Merchant signed** exist. Tags are created in **Settings**, under **Tags**.
- The contact has an **email address**. Secure Sign needs an email for every person who signs, even when the link goes by WhatsApp.
- You have permission to manage automations **and** to send documents. Without the second one, saving or switching on an automation that sends documents is refused.

## Part 1: send the application when a contact is tagged

1. Click **Automations**. Near the top, click the **Merchant onboarding** card. If you do not see it, Secure Sign is not on for you.
2. The trigger is **Tag added**. The tag **Merchant applicant** is picked for you if it exists; if not, choose a tag.
3. Open the step **Send document for signing**. The template **Merchant Application** is picked for you if it exists; if not, choose it.
4. Under **Who signs**, the **Merchant** role is set to **The contact**. Add more people if your template has more roles, for example a director who countersigns. A role marked with a star must have a person.
5. Anyone who should only get the signed file, such as your accountant, can be added as a recipient who **Receives a copy**. They have no role and no link, and are sent the signed PDF by email when everyone has signed. See [Receive a copy of the signed document](/help/doc-sign/copies).
6. Under **Fill in the document**, add values for the template's merge fields if you use any. Use the **Insert variable** button to put in the contact's company or name.
7. Leave **Send it now** ticked to send straight away. Untick it to save the document as a draft for a person to check and send.
8. Give the automation a name, switch it **Active** and click **Save**.

If something is wrong, saving an active automation shows the first problem, for example "the template needs a recipient for the role Merchant" or "that Secure Sign template is not active".

From now on, adding the tag **Merchant applicant** to a contact makes a document from the template, links it to that contact, and sends the signing link to their email. You can see the document in **Secure Sign**, and its history shows it was made from a template.

## Part 2: follow up when it is signed

1. Click **Automations**, then the **Merchant signed follow-up** card.
2. The trigger is **Secure Sign event**, set to **Everyone has signed (completed)**. Pick the **Merchant Application** template so other documents do not start it.
3. The steps are: **Add tag** (**Merchant signed**), **Create ticket** (**Merchant KYC review**) and **Send message** (the thank-you).
4. Check the ticket text and the message. They already use the document's reference and the contact's name. You can change the wording.
5. Switch it **Active** and click **Save**.

When the last person signs, the contact gets the tag, your team gets a ticket to review the company details and documents (with a link to the page that proves the signed file is genuine), and the merchant gets the message.

The thank-you message needs an existing conversation with the contact. It runs last, so the tag and the ticket are done even if there is no conversation.

## Other things an automation can react to

In the **Secure Sign event** trigger, tick any of: a document is **sent**, a signer **opens** it for the first time, **everyone has signed**, a signer **declines**, a document **expires**, a document is **cancelled**. You can limit it to one template or one category.

Useful examples:

- A signer declines: create a ticket so someone calls them.
- A document expires: send the contact a new one.
- A document is sent: tag the contact so you can find who is waiting.

In the steps after the trigger, the **Insert variable** button offers the document's reference, title, template and, once signed, the link that proves the file.

## What happens when something goes wrong

The step does not stop the rest of the automation. In the automation's log, open the run and look at the step. It says **skipped** and why, for example:

- the contact has no email address
- your monthly limit of documents is reached (the document is kept as a draft so someone can send it later)
- the template is no longer active
- the document is not ready to send, with the problem named

If the same run reaches the step twice, it does not make a second document.

## Tips

- Try it with a test contact of your own first, using your own email address.
- Keep the thank-you short. The merchant has just signed and wants to know what happens next.
- If you also use your own system, the same events can be sent to it as webhooks. Ask your developer; see [API and integrations](/help/doc-sign/api-and-integrations).

## Common mistakes

- **Choosing a template that is still a draft.** The template must be **Active**. Open it in Secure Sign > Templates and activate it.
- **A contact without an email.** The step is skipped. Add the email to the contact, or use **A fixed person** for the recipient.
- **Forgetting a role.** If the template has a director who must sign, the step needs a person for that role too.
- **Leaving the template filter empty on the follow-up.** Then every completed document of any kind starts it. Pick the template.
- **Expecting the follow-up to run when the document is only sent.** It runs for the events you ticked. By default that is only **completed**.
- **Tagging the same contact twice.** Each tag added is a new run, so a second document is made. Remove the tag and add it once.

## Related pages

- [Send a document for signature](/help/doc-sign/send-a-document)
- [Templates](/help/doc-sign/templates)
- [Categories and add-ons](/help/doc-sign/categories-and-add-ons)
- [Receive a copy of the signed document](/help/doc-sign/copies)
- [Remind, resend and cancel](/help/doc-sign/remind-resend-and-cancel)
