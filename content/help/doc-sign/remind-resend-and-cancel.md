---
title: Remind, resend and cancel
description: Follow a sent document, nudge a person, send an invitation again, change a recipient, cancel the document, or cancel one that is already completed.
order: 6
updated: 2026-10-08
---

After you send a document, its page shows where things stand and gives you the actions that keep it moving.

## Before you start

Open **Secure Sign**, then **Documents**, and click the document. Reminding, resending and changing a recipient need permission to send. Cancelling needs permission to void. If a button is missing, your role does not have it.

## Follow progress

A banner at the top says what is happening, for example "Waiting for Ali (1 of 2 signed)". Below it, the **People** tab lists each person with their state: **Not invited yet**, **Invited**, **Opened**, **Signed**, **Filled in** or **Declined**. The **Document** tab shows the file and the **History** tab shows what happened. See [The audit trail and the sealed PDF](/help/doc-sign/audit-trail-and-sealed-pdf).

Secure Sign also sends automatic reminders. They follow the reminder days set on the document, which come from its category and your workspace settings, and stop when the document is completed, declined, cancelled or expired.

## Remind a person

1. On the **People** tab, find the person.
2. Click **Remind**.
3. Confirm with **Send reminder**.

The person gets a reminder by the channel you chose for them, with a **new link**. The earlier link stops working. A reminder can be sent again only after some time has passed; the button tells you when.

## Send the invitation again

Click **Resend** next to the person, then **Send again**. They get the invitation again with a new link, and the earlier link stops working. Use it when they say they never got it.

If the message could not be delivered, the person shows "The email did not arrive" or "The WhatsApp message did not arrive", with the reason under it. Read the reason first. If it says the address was not accepted, check the address or number and change the recipient if it is wrong. If it says the mailbox needs to be reconnected, has reached its limit for the day, or asked Secure Sign to slow down, nothing is wrong with the address: fix the mailbox (**Settings > Secure Sign > General > Email** shows which one it is) or wait, then use **Resend**. You can also use **Copy link** and pass the link on yourself.

## Change the recipient

Use this when the document should go to a different person or address.

1. Click **Change recipient** next to the person.
2. Enter the new name, email, phone (needed for WhatsApp) and how to send.
3. Click **Change and send**.

The new person takes the same place in the order and gets a new link. The earlier link stops working.

## Cancel a document

Cancel a document that should not be signed any more.

1. Click **Cancel document**.
2. Say why. The reason is kept in the history.
3. Confirm.

Every link stops working and the people who were waiting are told. A cancelled document stays in the list with the status **Voided**. This cannot be undone: send a new document if you still need one.

> [!NOTE]
> You cannot edit a document once it is sent. Cancel it and send a new one with the change.

## Cancel a completed document

A document that everyone has signed is a sealed record, so it cannot be voided. If it should no longer be in force (it was signed with the wrong price list, for example), the person who sent it, or an admin, can **cancel** it after the fact. This is separate from the cancel above and does not need permission to void.

1. Open **Secure Sign**, then **Documents**, and find the completed document. Click the three dots at the end of its row and choose **Cancel document**, or open the document and click **Cancel document** at the top. You only see it when you sent the document or you are an admin or owner.
2. Say why. A reason of 3 to 500 characters is required. Everyone who can see the document can read it.
3. Tick **Notify everyone** if you want an email to go to the signers, the people who receive a copy and you (one short email each, with no link and no document). It is off unless you tick it.
4. Confirm with **Cancel document**.

What happens:

- The document is marked **Cancelled** instead of **Completed** in the list, with a banner on its page showing who cancelled it, when and why. Use the **Cancelled** filter to find these documents. The **Completed** filter leaves them out, and **All** includes everything.
- **Nothing about the signed document changes.** The signed PDF, the certificate and the history stay exactly as they were, and you can still download them. They are a record of what was signed, but the document is no longer in force. The History tab adds a line for the cancellation.
- Signers who open their link see "This document was cancelled on" the date, with their downloads still there. The public check page, which anyone with the PDF can open, still confirms the file is genuine and adds "Cancelled on" the date. Neither shows the reason or who cancelled it.
- A document that belongs to a [document collection](/help/doc-sign/document-collections) is cancelled with the whole collection. The dialog says "This cancels all 3 documents in the collection", for example.
- **This cannot be undone.** A cancelled document cannot be reactivated. Send a new document if you still need one.
- It is kept for the same time as any completed document. See [Retention](/help/doc-sign/retention).

## When it did not finish

If the status is **Could not finish**, everyone signed but the signed copy could not be sealed yet. Nothing is lost. It is tried again by itself. If it stays like this, tell your admin.

## Tips

- Give the person a few days before reminding. The automatic reminders usually do the job.
- Always write a clear reason when you cancel. It helps whoever reads the history later.

## Common mistakes

- **Looking for Cancel document on a document that is not completed yet.** For one that is still out for signature, use the cancel described above (it needs permission to void). Cancel document on a completed document is for one that has been signed.
- **Cancelling when you only wanted to correct an email address.** Use **Change recipient**, which keeps the document and the order.
- **Sending the earlier link again.** After a reminder, resend or change, only the newest link works.

## Related pages

- [Send a document for signature](/help/doc-sign/send-a-document)
- [What the signer sees](/help/doc-sign/what-the-signer-sees)
- [Signing order](/help/doc-sign/signing-order)
