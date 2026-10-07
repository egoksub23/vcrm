---
title: Settings and the WhatsApp template
description: Set the defaults for new documents, the consent wording, the sender name and the WhatsApp message template, and see which mailbox your email is sent from.
order: 10
updated: 2026-10-07
---

Secure Sign settings are the starting point for every new document. A category, a template or the sender can change them for one document.

## Before you start

Open **Settings** and click **Secure Sign**. The tab is there only if your platform operator switched Secure Sign on for your workspace and your role may manage Secure Sign settings. Changes are written to the audit log.

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

## Email: which mailbox your messages are sent from

At the top of **General** is an **Email** card. It shows how Secure Sign sends invitations, reminders, codes and signed copies. There is nothing to switch on it: it only tells you.

| What the card says | What it means |
|---|---|
| **Sent from support@yourcompany.com via your connected Microsoft 365 mailbox** (or **Gmail mailbox**) | Messages go out from that mailbox, under your workspace's name. Replies go to the address your workspace set for replies, or to the mailbox. |
| **Sent by the platform sender** | You have no connected mailbox that can send, so messages go out from the platform's own address. Connect a mailbox to send from your own address. |
| **Not set up** | There is no mailbox and no platform sender, so nothing is sent. The document's page says so for each person. Connect a mailbox. |
| A line about a mailbox that **needs to be reconnected** or **is switched off** | Secure Sign skips it. Fix it in Settings > Channels. |

The link on the card opens **Settings > Channels** on the tab of that mailbox (**Email** for Microsoft 365, **Gmail** for Gmail). If you connected both, Microsoft 365 is used.

Click **Send a test email to me** to send one short message to your own address, the same way real messages go. If it does not go, the card tells you why, for example that the mailbox needs to be reconnected or has reached its limit for the day. You can send five an hour.

What to know about sending from a mailbox:

- **Gmail** keeps every message in the mailbox's **Sent** folder, so anyone who can open that mailbox can read the signing links in it. **Microsoft 365** messages are not kept in Sent Items.
- Secure Sign messages are never added to the Halo Inbox, even when they are sent to the mailbox's own address.
- A mailbox can only send so many messages. Gmail allows about 500 a day (2,000 for Google Workspace); Microsoft 365 about 30 a minute. When it is reached, the person shows "The email did not arrive" with the reason. Wait, then use **Resend**.
- A signed copy is attached to the email when it is small enough: up to 2.5 MB through Microsoft 365 and 17 MB through Gmail. A larger one is not attached; the email links to it instead.

## Consent wording

Before a person signs, they agree to use electronic records and signatures. The standard wording is used for each language unless you write your own.

1. Open **Consent wording**.
2. Find the language and turn on **Use our own wording**. The standard text fills the box so you can adjust it.
3. Edit the text, up to 2000 characters, and click **Save wording**.

Each wording has a **version**, shown beside it. Changing the words makes a new version, and the version a person agreed to is saved with their signature. To go back to the standard wording, turn the switch off and save.

> [!IMPORTANT]
> The standard wording is a starting point. Have your own wording, and the standard one, read by someone qualified in your country before you rely on it for contracts.

## WhatsApp invitations

A document you send from the **People** step always goes by email. WhatsApp is used by a bulk send or a registration page that is set to it, and for a person who was saved with WhatsApp in a draft made earlier (that person is marked **Sent by WhatsApp**). WhatsApp only sends message templates that Meta has approved, so Secure Sign needs the name of one.

1. In your WhatsApp account, create a message template. It needs three variables, in this order: the person's name, the document title and the signing link.
2. Wait for Meta to approve it.
3. In **Settings**, **Secure Sign**, **General**, enter the **Template name**, exactly as in your WhatsApp account (lower case letters, digits and underscores).
4. Enter the **Template language code** the template was approved in, for example `en`, `ms` or `en_US`.
5. Click **Save**.

Until a template is set, an invitation chosen to go by WhatsApp is not delivered. The document's page shows that the person was not reached. Use email, or [copy the link](/help/doc-sign/remind-resend-and-cancel) and pass it on.

WhatsApp also needs your WhatsApp channel to be connected. See [Roles and permissions](/help/getting-started/roles-and-permissions) if you cannot see the Channels settings.

## Sealing certificate

The **Sealing certificate** tab shows the certificate your documents are sealed with: its name, subject, the date it is valid until, and whether it is self-signed. You can install a certificate from a certificate authority there. See [The sealing certificate](/help/doc-sign/sealing-certificate) and [The audit trail and the sealed PDF](/help/doc-sign/audit-trail-and-sealed-pdf).

## Retention

On the **General** tab, **Retention** is how many years a signed document is kept, from 1 to 50. See [How long signed documents are kept](/help/doc-sign/retention).

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
