---
title: Prepare the fields
description: Place signature, text, date and other fields on the pages, give each to a role, and check the layout before sending.
order: 3
updated: 2026-10-08
---

Fields are the boxes on the pages that people sign or fill in. You place them once, give each one to a **role**, and then match the roles to real people on the **People** step.

The same editor is used for a draft document and for a template. On a template you also set defaults and save versions. See [Templates](/help/doc-sign/templates).

## Before you start

You need a draft document or a template with its pages showing. For a draft, you need permission to send. For a template, you need permission to manage templates.

## Roles

A role is a part in the document, for example **Merchant** or **Director**. Every field belongs to one role.

- A role is either a **signer** (signs the document) or a **filler** (fills in fields but never signs). A filler never reaches the signing step.
- A document can have up to six roles. Each role has a colour, so you can see at a glance whose field is whose.
- Fields the sender writes onto the document, such as a fee, belong to the sender and are not filled in by anyone else.

Add, rename or remove roles in the roles panel. If you remove a role that has fields, you choose where those fields go, or remove them.

## Place a field

1. Choose the type of field in the toolbar.
2. Click on the page where it goes, or drag to draw its size.
3. Choose its role.
4. Set its properties, such as whether it is required and its label.

You can move, resize, copy and delete a field, and nudge it with the arrow keys. Page thumbnails and zoom help with long documents.

## Field types

| Type | What it collects |
|---|---|
| **Signature** | The person signs by drawing, typing or uploading a picture of their signature |
| **Initials** | The same, for initials |
| **Full name** | The person's name |
| **Date signed** | Filled in automatically with the day the person signs |
| **Date** | A date the person picks |
| **Text** | A line of text, or several lines if you allow it |
| **Number** | A number, with the digits after the decimal point you choose |
| **Checkbox** | A tick box |
| **Dropdown** | A choice from a list you write |
| **Picture upload** | A photo or image, for example an ID copy |
| **Static text** | Words you write on the document, or a value taken from the contact |

Some values can be filled in before sending, for example from the contact. The **Fields** step shows a panel for these values.

## Replace the file of a draft

Uploaded the wrong version, or the customer sent a corrected file? On a **draft** you do not have to start again. In the Fields step, click **Replace file** and choose the new PDF, Word file or image.

Before anything changes, Doc Sign tells you what would happen:

- how many pages the new file has, and how many the old one had
- **fields that keep their place**: the page is still there and is the same size, so the field stays exactly where you put it
- **fields that need a look**: a field whose page is no longer in the new file is moved to the last page so you can still find it; a field on a page that is a different size or shape (A4 became Letter, portrait became landscape) stays where it is but may no longer line up

Click **Replace file** to go ahead, or **Cancel** to change nothing. The roles, the people, the options and the form are not touched. The Problems list in the editor then shows anything left to fix, and nothing can be sent until it is fixed.

> [!IMPORTANT]
> Only a draft can have its file replaced. Once a document is sent its file is fixed. Cancel it and send a new one.

The replacement is recorded in the document's history ("replaced the file of the draft").

## Check it before you send

The editor checks the layout as you work. It tells you about a field with no role, a role with no signature field, or a field that falls off the page. On the **Review** step, the same checks stop you from sending until they are fixed.

Every signer needs a signature or an initials field. A filler does not.

## Tips

- Make a field a little bigger than you think. A signature drawn with a finger needs room.
- Put the **Date signed** field next to each signature.
- Use required fields only for what you really need. A required field stops a person from finishing.

## Common mistakes

- **Giving a field to the wrong role.** The person only sees the fields of their own role. Check the colours.
- **Forgetting a signature field for one of the signers.** The review tells you and takes you back to the fields.
- **Placing fields on a Word file before checking the converted pages.** Look at every page first: the conversion can move text.
- **Replacing the file and not checking the flagged fields.** When the new file has fewer pages or other page sizes, open each flagged field and put it right.

## Related pages

- [Send a document for signature](/help/doc-sign/send-a-document)
- [Signing order](/help/doc-sign/signing-order)
- [What the signer sees](/help/doc-sign/what-the-signer-sees)
