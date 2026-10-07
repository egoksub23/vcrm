---
title: Bulk send, export and download as zip
description: Send one template to many people from a CSV file or your contacts, export the documents list as a spreadsheet, and download signed files together as a zip.
order: 16
updated: 2026-10-07
---

This page covers three things you do with many documents at once: **sending** one template to a list of people, **exporting** the documents list as a spreadsheet, and **downloading** the signed files of several documents as one zip.

## Before you start

- To send in bulk you need permission to send documents, and the template must be **Active**. See [Templates](/help/doc-sign/templates).
- To export or download you only need to be able to see Secure Sign.
- Bulk send counts against your workspace's monthly limit of documents sent, exactly like sending one by one.

## Send one template to many people

1. On the **Documents** tab click **Bulk send**.
2. **Template.** Choose the template. Everyone on your list gets their own copy.
3. **People.** Either upload a CSV file or choose contacts.
   - **A CSV file** can hold up to 500 people and 1 MB. The first row must name the columns. `full_name` and `email` are required. `phone` and `contact_id` are optional. If the template fills in values for each person (a business name or a fee, for example), add one column for each, named exactly like the value. Click **Download a sample file** to get a file with the right columns. Save the file as CSV (UTF-8); names in Bahasa Melayu, Chinese or Korean are fine.
   - **Contacts** are picked one by one, up to 500. Each contact needs an email address. If the template needs values a contact does not have, use a file instead.
4. **Setup.**
   - Say which **role** the people on your list fill. A template with a merchant and a director, for example, might have your list fill the merchant.
   - For every other role that has something to complete, give **one fixed person** (your own director, say). The same person is on every document.
   - Choose how the people on the list are reached: email, or WhatsApp (this needs a phone number with the country code, like +60123456789, for everyone).
   - Optionally set the title (`{name}` becomes the person's name), category, language, a message, how many days the link lasts, reminders, a verification code and signing order. Anything you leave on **Use the default** follows the template, then the category, then the workspace.
5. **Check and send.** Nothing is sent yet. You see every person with their problems, and whether this month's limit has room for the batch. Fix the file and click **Check again**, or tick **Send to the people without a problem and skip the rest**. When it looks right, click **Send**.

### What is checked

For each person: a name, an email address that is valid and appears only once in the file, every value the template needs, and a phone number when you use WhatsApp. For the whole batch: that the template can be sent with these people, and that the month's limit has room. If it does not, nothing is sent at all. You are told how many documents you can still send this month.

### People who receive a copy of every document

On the **Setup** step you can also add **people who receive a copy**: for example your own finance team, who should have the signed PDF of every document in the batch. Click **Add a person** under **People who receive a copy**, and type a name and an email address (or choose a contact for the name). You can add up to **10** people, and each address can be listed once.

- They are **not signers**. They never get a signing link and are not counted in the progress.
- Each of them gets **one email with the signed PDF** of each document, when that document is completed.
- Anyone who signs a document is **left out of that document's copies**. If one of your fixed people, or a person on your list, is also on the copy list, they get the signed copy as a signer instead. The **Check and send** step names them.
- The **Check and send** step lists the people who will receive a copy, so you can look once more before you send.

A person you started to add but did not finish stops you moving on from the Setup step until you complete or remove them. For more on what a copy email holds and what these people never get, see [Receive a copy of the signed document](/help/doc-sign/copies).

### What happens next

The documents are made and sent by the server in the background, roughly 15 to 25 documents a minute, so a batch of 500 takes about half an hour. You can close the page. Open **Bulk send** again to see **Recent bulk sends**, or come back to the batch page, which updates by itself while it runs.

The batch page shows how many are sent, failed, skipped and waiting, and for each person the document (click it to open) or the reason it was not sent. Click **Download results (CSV)** for the same table as a file.

- **Sent** means the document was made and sent. It appears in the documents list like any other, with its own reference and history.
- **Failed** means that document could not be sent. If a draft was made, it is linked in the row so you can open it.
- **Skipped** means it was left out: a problem you chose to skip, or the batch was cancelled.
- If the month's limit is reached part of the way, the people not yet reached are marked **Failed** with the reason, and nothing is thrown away.

To cancel, click **Cancel the rest** on the batch page. Documents already sent stay sent. The document being sent at that moment is finished.

To send to the people who failed, fix their rows in your file and start a new bulk send with only those rows.

## Export the documents list as a spreadsheet

Click **Export CSV** above the documents list. You get the documents that match the filters on screen (status, category and search), newest first, with these columns: reference, title, category, status, contact, signers, created, sent, completed, expires and mode (`sign` for an agreement, `form` for a [form without a signature](/help/doc-sign/forms-without-signature)). Up to 50,000 documents are exported. The file opens in Excel or Google Sheets with names shown correctly. Dates are in UTC.

A cell that would be read as a formula is saved as text, so a document title can never run something in your spreadsheet.

## Download signed files as a zip

1. Tick the documents in the list. Use the box at the top of the column to tick everything on the screen. You can tick up to 50.
2. Click **Download selected as zip**.

Only **completed** documents have a signed file. The others are left out, and the page tells you how many. The zip also holds a short note, `NOT-INCLUDED.txt`, saying which ones and why. Each file is named with the document's reference and title. The signed PDF already contains its certificate pages and history, so nothing else is needed.

Each document put in a zip is recorded in its history as downloaded, the same as opening the signed copy.

## Tips

- Try a small file of three or four people first. The check shows you exactly what will be sent.
- Keep your file as the source of truth. The results file has the same row numbers, so you can find any person quickly.
- Use a title like `Merchant Agreement: {name}` so the documents are easy to tell apart in the list.

## Common mistakes

- **Saving the file as Excel (.xlsx).** Choose Save as and pick CSV (UTF-8).
- **Leaving out the header row, or renaming a column.** The first row must say what each column is. A value column must match the template's name for it exactly; the check shows unused columns.
- **The same person twice.** An email address can appear once per file. Remove the repeat, or send it separately.
- **A WhatsApp batch without phone numbers.** Every person needs a number with the country code.
- **Expecting a zip of drafts or waiting documents.** Only completed documents have a signed file.

## Related pages

- [Send a document for signature](/help/doc-sign/send-a-document)
- [Templates](/help/doc-sign/templates)
- [Receive a copy of the signed document](/help/doc-sign/copies)
- [Signing order](/help/doc-sign/signing-order)
- [Remind, resend and cancel](/help/doc-sign/remind-resend-and-cancel)
