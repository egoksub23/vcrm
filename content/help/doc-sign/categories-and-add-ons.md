---
title: Categories and add-ons
description: Group documents and templates in categories with their own starting choices, and install ready-made add-on packs.
order: 8
updated: 2026-10-08
---

A **category** labels documents and templates and sets the starting choices for them. An **add-on** is a ready-made pack for a business process, such as signing merchant agreements. Both are managed in **Settings**, under **Doc Sign**, by someone allowed to manage Doc Sign settings.

## Categories

Every workspace starts with four categories: **Merchant agreements**, **NDA**, **Partnership** and **Sales**. You can add your own, rename them and archive them. Lists in Doc Sign can be filtered by category.

### What a category sets

A category can set the starting choice for:

- how many days a document stays open before it expires
- the reminder days
- whether a verification code is needed
- whether the document needs signing order
- how long signed documents are kept
- its own consent wording, per language

Anything the category leaves empty follows your workspace setting. The sender can still change each choice on a document, so a category is a starting point, not a lock. When choices overlap, the one set closest to the document wins: what the sender chose on the document, then the template, then the category, then the workspace.

### Create or change a category

1. Open **Settings**, then **Doc Sign**, then **Categories**.
2. Click **New category**, or the pencil next to one to edit it.
3. Fill in the name and any starting choices. Leave a choice empty to use the workspace setting.
4. Click **Create category** or **Save**.

A short key is made from the name when you create the category and cannot be changed afterwards. Renaming is always possible.

### Order, archive and restore

Use the arrows to move a category up or down in the list. A category cannot be deleted, only archived, so documents keep their label. Click the archive button to hide one; tick the box that shows archived categories to see it again, and use the restore button to bring it back.

> [!NOTE]
> Categories can store their own consent wording and retention period. The signing page currently uses the workspace's wording only; a category's own wording takes effect in a later update. A category's retention period is used for the documents of that category when they are sealed (see [How long signed documents are kept](/help/doc-sign/retention)).

## Add-ons

Open **Settings**, then **Doc Sign**, then **Add-ons**. Each card shows the add-on's name, what it adds and its state:

- **Not installed**: ready to install.
- **Installed v2.0**: installed, with its version.
- **Update to v2.0 available**: a newer version of the add-on exists. See "Update an add-on" below.
- **Not available**: your platform operator has not switched it on for your workspace. Only the operator can make an add-on available. Ask them.

### Install an add-on

Click **Install**. Doc Sign:

- adds the add-on's category if you do not have it, or marks your existing one as belonging to the add-on without changing its choices
- adds its templates as drafts for you to review
- records the version that is installed

Installing never changes a template you have edited. You can press **Install again** at any time: it only adds what is missing.

### Update an add-on

When a newer version of an installed add-on is out, its card shows **Update available**, a short list of what changed (in your language), and an **Update** button.

1. Read the list of changes.
2. Click **Update to v2.0**.

What happens to each template of the add-on depends on whether you have changed it:

| Your template | What the update does |
|---|---|
| **You have not edited it** (you may have renamed it in your list, made it active or tagged it, that is fine) | It gets a **new version** with the new layout and form. Its name, status, category and earlier versions stay. |
| **You have edited it** (moved a field, changed the form, the roles or the starting choices) | It is left **exactly as it is**. A new copy named **“Merchant Application (updated)”** is added next to it as a draft, so you can compare and switch over when you like. |
| **You deleted it** | Nothing is brought back. Press **Install again** if you want it. |

When the update is done, a note under the heading tells you which of these happened to each template, and it stays until you close it.

An update never changes a document that was already sent, and a draft you started earlier keeps the version it was made from. The change is recorded in the workspace audit log: who updated it, from which version to which. Pressing **Update** twice is harmless; the second time there is nothing left to do.

### Merchant Registration

The first add-on, **Merchant Registration**, is for signing merchant agreements. It sets up the **Merchant agreements** category and the **Merchant Application** template, which a merchant fills in parts and signs.

**What version 2.0 changed** (for a workspace that installed 1.1):

- State, country, bank, company ID type, e-invoice phase and tax type take their choices from your **shared lists** (Settings, Doc Sign, Lists), so a bank or a state is changed once for every form. See [Option lists](/help/doc-sign/option-lists).
- Business MSIC codes are picked from the full MSIC list with a search box.
- The **bank account number** and the **business registration number** are [sensitive answers](/help/doc-sign/sensitive-fields): stored encrypted, shown masked to you with a logged Reveal, and left out of exports and the API. On the signed copy the account number is printed as its last four digits; the registration number is printed in full because the agreement has to name the company. The tax identification number (TIN) is not marked sensitive: it is shared on every e-invoice and your staff need it in full. If your workspace only signs up companies, you can switch the registration number's protection off in the template editor.
- The template file, its layout and its wording are unchanged.

## Tips

- Make a category for each kind of document you send, so the filters and the starting choices fit.
- Turn on a verification code in the category for documents that carry sensitive information.

## Common mistakes

- **Archiving a category that is still in use.** Existing documents keep it. New documents cannot be put in an archived category.
- **Looking for the add-on's templates right after installing.** If the card says templates come in a later update, only the category is added for now.
- **Expecting an update to overwrite a template you edited.** It never does. Look for the copy named “(updated)” next to it.
- **Pressing Update and expecting old documents to change.** Documents already sent, and drafts already started, keep what they were made with.

## Related pages

- [Templates](/help/doc-sign/templates)
- [Option lists](/help/doc-sign/option-lists)
- [Sensitive answers](/help/doc-sign/sensitive-fields)
- [Settings and the WhatsApp template](/help/doc-sign/settings-and-whatsapp)
- [Signing order](/help/doc-sign/signing-order)
