---
title: Import and export contacts
description: Bring many contacts in from a CSV file, save your contacts as a CSV file, and what to do about errors.
order: 3
updated: 2026-09-21
---

If you have a list of customers in a spreadsheet, you can add them all at once with a CSV file. A CSV file is a plain spreadsheet that saves as `.csv`.

## Before you start

Your file needs a first row with column names. Write the names in English, as shown here.

| Column | Required | What goes in it |
|---|---|---|
| `phone` | Yes | The phone number, with the country code. |
| `name` | No | The contact's name. |
| `email` | No | The email address. |
| `company` | No | The company name. |
| `tags` | No | Tag names separated by commas or semicolons. Put quotes around a cell that holds more than one tag. |

The order of the columns does not matter. Other columns are ignored, so custom fields cannot be imported this way.

## Import a file

1. Click **Contacts** in the sidebar.
2. Click **Import**.
3. Click **Click to choose a CSV file** and pick your file.
4. Check the line that says how many rows are ready. Check the preview of the first five rows. It shows the Phone, Name, Email, Company and Tags columns.
5. Click **Import** with the number of contacts, for example **Import 120 contacts**.
6. Wait for **Import complete**, then read the result lines.

![The Import Contacts window before a file is chosen.](/help/img/import-and-export-01-dialog.png)

## Read the result

| Line | What it means |
|---|---|
| **imported** | Contacts that were created. |
| **tags assigned** | Tags that were put on the new contacts. |
| **skipped** | Rows that repeat a number already in the file, or a number that already exists as a contact. |
| **invalid phone** | Rows with no usable phone number. |
| **failed** | Rows the system could not save. The **Failed rows** list shows the phone number and the reason. |

Existing contacts are never changed by an import. A repeated number keeps the first row and skips the rest.

## Tags in your file

Tag names are matched ignoring capital letters. If a tag name does not exist yet:

- an Agent's import skips it and tells you: "Unknown tags skipped (create them in Settings first)". Ask your admin to create the tag, then add it to the contacts by hand.
- someone allowed to manage tags creates it during the import, with a default blue colour.

Only tags that are already approved can be used. A tag that is still waiting for approval does not count.

## Export

To save your contacts as a file:

1. Click **Contacts** in the sidebar.
2. If you only want some contacts, type in the search box or choose tags with **Filter by tags**. The file follows what you have set, and it holds every match, not just the 25 on the page.
3. Click **Export**.
4. Wait a moment. A file called `contacts-` and the date, ending in `.csv`, is saved by your browser.

The file has the columns `phone`, `name`, `email`, `company` and `tags`, and a `created_at` column with the date the contact was added. Tag names are separated by a semicolon and a space. Custom fields, notes and deals are not in the file.

Because the first five columns are the ones Import reads, you can import an exported file into another workspace. Some cells start with an apostrophe, for example `'+44 7911 123456`. That keeps a spreadsheet from treating the cell as a formula, and Import removes it again.

> [!NOTE]
> A different export is **Export CSV** on the page of a single broadcast. It saves the recipients of that broadcast. See [Broadcasts](/help/working-together/broadcasts).

## Tips

- Test with a small file of five rows first.
- Keep the browser tab open until you see **Import complete**. Large files are saved in batches.
- Save your spreadsheet as CSV before you import. A spreadsheet in another format will not read correctly.

## Common mistakes

- No `phone` column, or a differently spelled header. The app then says: No valid rows found. Ensure CSV has a "phone" column header.
- A phone number without the country code.
- Several tags in one cell without quotes when you separate them with commas.
- Expecting an import to update existing contacts. It only adds new ones.

## Who can import and export

By default Agents can import and export contacts. Both buttons use the same permission. If **Import** or **Export** is greyed out, ask your admin. See [Roles and permissions](/help/getting-started/roles-and-permissions).

## Related pages

- [Contacts overview](/help/contacts/contacts-overview)
- [Merge duplicates](/help/contacts/merge-duplicates)
