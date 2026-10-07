---
title: Option lists
description: Keep the states, countries, banks and MSIC business codes that your forms offer in one place, use them in any form, and load your own with a CSV file.
order: 12
updated: 2026-10-07
---

Many questions on a form have the same answers every time: which state, which country, which bank, which business activity. An **option list** keeps those answers in one place, so you word them once and every form that needs them uses the same list. The signer searches the list on their phone instead of scrolling through hundreds of lines.

Lists live in **Settings**, then **Secure Sign**, then the **Lists** tab. Anyone who can see Secure Sign can read them. Changing them needs the permission to manage Secure Sign settings.

## The lists that come with Secure Sign

Your workspace starts with these. You cannot delete them, but you can change their wording and add to them.

| List | What it holds |
|---|---|
| **States of Malaysia** | The 13 states and the 3 federal territories |
| **Countries** | The countries and territories of the ISO list, with Malaysia first, in English and Bahasa Melayu (and Chinese and Korean for the countries Malaysian businesses deal with most) |
| **Banks in Malaysia** | The main banks, with "Other" for the rest |
| **Company registration ID types** | NRIC, ROC, BRN, passport, army or police number |
| **E-invoice phases by turnover** | When a business must start e-invoicing, by yearly turnover |
| **Tax types** | SST, service tax, sales tax, tourism tax, not applicable |
| **MSIC business activity codes** | The 1,174 five-digit codes of MSIC 2008, in English and Bahasa Melayu |

> [!NOTE]
> The wording of the company ID types, the e-invoice phases, the tax types, the banks and the Bahasa Melayu country names are sensible starting values that your team should read once and correct where needed. The MSIC codes are the official ones, published by the Department of Statistics Malaysia (DOSM) under the Creative Commons Attribution 4.0 licence.

You can also make **your own lists**, for example "Our suppliers" or "Branches".

## Use a list in a form

1. Open the template, then its **form**.
2. Choose a question that is a **choice**, a **multiple choice** or a **list of entries**.
3. Under **Where the options come from**, choose **A shared list** (for a list of entries, **Picked from a shared list**) and pick the list.
4. You see a short preview of what the question will offer. Save the template.

For a list of business codes, use a **list of entries** question and pick **MSIC business activity codes**. The signer can then add up to as many codes as you allow.

## What the signer sees

- A long list (more than 12 options) is a **search box**. They type a word or a code, in English or in their own language, and tap the match they want. It works with the keyboard and with a screen reader.
- For business codes they can add several, one by one, and remove one they added by mistake. The code is shown before the name.
- A short list is shown as before: a few large buttons, or the phone's own menu.

## Changing a list never changes a document that was sent

A form takes a **copy** of the list in three moments: when you save the template, when a document is made from the template, and when the document is sent. After a document is sent it keeps the copy it was sent with. If you rename a state or add a bank later, documents already out are not touched, and the answers people gave still mean what they meant.

A new document made from the template after your change gets the new list. To bring an older template up to date, open its form and save it.

## Change a list

Open a list from the **Lists** tab. You can:

- **Add an item.** Give it a value (what is stored with the answer) and its wording in English, and in Bahasa Melayu, Chinese and Korean if you want. A language left empty reads as English.
- **Change the wording** of an item. The value never changes, so an answer keeps its meaning.
- **Archive an item** you no longer want. It disappears from new forms. It is never deleted.
- **Move an item** up or down (for lists you can reorder).
- **Rename the list** or change its description.
- **Archive the list.** Forms that already use it keep working.

The page also shows **which templates use the list**. This is a count only.

## Load a list from a CSV file

The quickest way to bring in many items, or to replace the MSIC list with your own copy, is a CSV file saved from Excel as **CSV UTF-8**.

Use these columns, in any order. Only the first two are needed.

| Column | What it is |
|---|---|
| `value` (or `code`) | What is stored. Letters, digits and `_` `.` `-`. For MSIC, five digits |
| `en` (or `description`) | The English wording |
| `ms` | Bahasa Melayu |
| `zh`, `ko` | Chinese, Korean |
| `group` | A short heading, for example the two-digit division of an MSIC code |
| `archived` | `yes` to hide the item |

For MSIC you can use `Code`, `Description` and `Description (Malay)`.

1. Open the list and choose **Import CSV**, then choose the file.
2. Read the summary: how many items are new, changed, unchanged or removed, and every row that cannot be used and why. Nothing is saved yet.
3. Choose how to apply it. **Add new items and update the ones that are there** keeps everything else. **Replace the whole list** (your own lists only) makes the list exactly the file.
4. Choose **Import**.

A row with a problem is left out and listed; the other rows are used. **Export CSV** gives you the list in the same layout, so you can edit it in Excel and import it back.

## Put a list back to how it came

On a list that comes with Secure Sign, **Reset to default** puts every item back to its original wording and place and shows the archived ones again. Items you added stay, after them. Nothing is deleted, and forms already made are not changed.

## Common mistakes

- **Expecting an old document to change.** It will not: it keeps the list it was sent with. Make a new document to use the new list.
- **Expecting an old template to update by itself.** Open its form and save it; a new document made after that has the new list.
- **Using a value with spaces or accents.** A value is for the computer: letters, digits and `_` `.` `-` only. Put the nice wording in the English column.
- **Losing the leading zero of an MSIC code in Excel.** `01111` becomes `1111`. Secure Sign puts the zero back and tells you, but it is safer to format the column as text.
- **Deleting instead of archiving.** Lists and items are archived, not deleted, so that forms and answers never lose their meaning.
- **Saving the CSV in the wrong format.** Choose **CSV UTF-8**, or Bahasa Melayu, Chinese and Korean letters can come out wrong.
- **Editing the wording of a list in a form.** Options that come from a list are changed on the list, in **Settings**, not in the form.

See also [Forms in parts](/help/doc-sign/forms-in-parts) and [Templates](/help/doc-sign/templates).
