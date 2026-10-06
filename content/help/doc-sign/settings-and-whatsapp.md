---
title: Settings and the WhatsApp template
description: Set the defaults for new documents, the consent wording, the sender name and the WhatsApp message template.
order: 10
updated: 2026-10-06
---

Doc Sign settings are the starting point for every new document. A category, a template or the sender can change them for one document.

## Before you start

Open **Settings** and click **Doc Sign**. The tab is there only if your platform operator switched Doc Sign on for your workspace and your role may manage Doc Sign settings. Changes are written to the audit log.

The page has five tabs: **General**, **Consent wording**, **Categories**, **Add-ons** and **Sealing certificate**. This page covers the first two. See [Categories and add-ons](/help/doc-sign/categories-and-add-ons) for the next two.

## General

| Setting | What it does |
|---|---|
| **Expires after (days)** | How long a document stays open. 1 to 365 days. |
| **Reminders (days after sending)** | Days after a person is invited, separated by commas, for example 3, 7. At most five, from 1 to 60. Empty means no reminders. |
| **Default language** | The language of the signing page and messages, unless the sender picks another. |
| **Sender name on invitations** | The name invitation emails come from. Empty uses the usual sender name. |
| **Keep signed documents for** | Read only. Set by the platform for now. |

Click **Save** when you change something.

## Consent wording

Before a person signs, they agree to use electronic records and signatures. The standard wording is used for each language unless you write your own.

1. Open **Consent wording**.
2. Find the language and turn on **Use our own wording**. The standard text fills the box so you can adjust it.
3. Edit the text, up to 2000 characters, and click **Save wording**.

Each wording has a **version**, shown beside it. Changing the words makes a new version, and the version a person agreed to is saved with their signature. To go back to the standard wording, turn the switch off and save.

> [!IMPORTANT]
> The standard wording is a starting point. Have your own wording, and the standard one, read by someone qualified in your country before you rely on it for contracts.

## WhatsApp invitations

You send by email unless you choose WhatsApp for a person. WhatsApp only sends message templates that Meta has approved, so Doc Sign needs the name of one.

1. In your WhatsApp account, create a message template. It needs three variables, in this order: the person's name, the document title and the signing link.
2. Wait for Meta to approve it.
3. In **Settings**, **Doc Sign**, **General**, enter the **Template name**, exactly as in your WhatsApp account (lower case letters, digits and underscores).
4. Enter the **Template language code** the template was approved in, for example `en`, `ms` or `en_US`.
5. Click **Save**.

Until a template is set, an invitation chosen to go by WhatsApp is not delivered. The document's page shows that the person was not reached. Use email, or [copy the link](/help/doc-sign/remind-resend-and-cancel) and pass it on.

WhatsApp also needs your WhatsApp channel to be connected. See [Roles and permissions](/help/getting-started/roles-and-permissions) if you cannot see the Channels settings.

## Sealing certificate

The **Sealing certificate** tab shows the certificate your documents are sealed with: its name, subject, the date it is valid until, and whether it is self-signed. It is read only. See [The audit trail and the sealed PDF](/help/doc-sign/audit-trail-and-sealed-pdf).

## Tips

- Set the language and the reminder days to what most of your documents need. A category can refine them.
- Test a WhatsApp template by sending a document to yourself before you use it with customers.

## Common mistakes

- **Entering a template name that is not approved yet.** The message is refused. Wait for Meta's approval.
- **Typing the template name in capital letters.** Use the name exactly as WhatsApp shows it: lower case letters, digits and underscores.

## Related pages

- [Categories and add-ons](/help/doc-sign/categories-and-add-ons)
- [Send a document for signature](/help/doc-sign/send-a-document)
- [What the signer sees](/help/doc-sign/what-the-signer-sees)
