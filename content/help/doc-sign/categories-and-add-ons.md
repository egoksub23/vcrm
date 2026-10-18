---
title: Categories and add-ons
description: Group documents and templates in categories with their own starting choices, and install ready-made add-on packs.
order: 8
updated: 2026-10-18
---

A **category** labels documents and templates and sets the starting choices for them. An **add-on** is a ready-made pack for a business process, such as signing merchant agreements. Both are managed in **Settings**, under **Secure Sign**, by someone allowed to manage Secure Sign settings.

## Categories

Every workspace starts with four categories: **Merchant agreements**, **NDA**, **Partnership** and **Sales**. You can add your own, rename them and archive them. Lists in Secure Sign can be filtered by category.

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

1. Open **Settings**, then **Secure Sign**, then **Categories**.
2. Click **New category**, or the pencil next to one to edit it.
3. Fill in the name and any starting choices. Leave a choice empty to use the workspace setting.
4. Click **Create category** or **Save**.

A short key is made from the name when you create the category and cannot be changed afterwards. Renaming is always possible.

### Order, archive and restore

Use the arrows to move a category up or down in the list. A category cannot be deleted, only archived, so documents keep their label. Click the archive button to hide one; tick the box that shows archived categories to see it again, and use the restore button to bring it back.

> [!NOTE]
> Categories can store their own consent wording and retention period. The signing page currently uses the workspace's wording only; a category's own wording takes effect in a later update. A category's retention period is used for the documents of that category when they are sealed (see [How long signed documents are kept](/help/doc-sign/retention)).

## Add-ons

Open **Settings**, then **Secure Sign**, then **Add-ons**. Each card shows the add-on's name, what it adds and its state:

- **Not installed**: ready to install.
- **Installed v2.0**: installed, with its version.
- **Update to v2.0 available**: a newer version of the add-on exists. See "Update an add-on" below.
- **Not available**: your platform operator has not switched it on for your workspace. Only the operator can make an add-on available. Ask them.

### Install an add-on

Click **Install**. Secure Sign:

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

Some updates change the template file itself, not only its fields (Merchant Registration 3.0, 3.1 and 3.2 are such updates: 3.0 redraws the commercial terms page, 3.1 the documents page and 3.2 the size of the two boxes of the commercial terms page). A template keeps the file it was made with, so for such an update **every** template, edited or not, is left exactly as it is and the new one is added next to it as **“Merchant Application (updated)”**. Nothing is overwritten and nothing is lost: look at the copy, and switch over when you like.

When the update is done, a note under the heading tells you which of these happened to each template, and it stays until you close it.

An update never changes a document that was already sent, and a draft you started earlier keeps the version it was made from. The change is recorded in the workspace audit log: who updated it, from which version to which. Pressing **Update** twice is harmless; the second time there is nothing left to do.

### Merchant Registration

The first add-on, **Merchant Registration**, is for signing merchant agreements. It sets up the **Merchant agreements** category and the **Merchant Application** template, which a merchant fills in parts and signs.

**What version 3.2 changed** (the Platform fee box of Part 5):

- **The Platform fee box starts with a standard rate text instead of placeholder lines.** It lists the base platform cost per student; the rate for POS, E-Store and Meal Plans; the rates for invoice and web link payment collection for the non school fees store and the school term fees store, by payment method; and two closing notes, on bank and payment gateway charges and on taxes. It is 23 lines, in groups with a blank line between them. **Check it and change it to your own rates before you use it.** It is ordinary text: open a copy of the template, choose the box and edit the text in its properties, as in version 3.0. A copy of the template can have different text for another group of merchants.
- **The two boxes changed size.** The Platform fee box is larger and holds **25 lines** (it held 17); the Key terms box is a little smaller and holds **42 lines** (it held 49). Fifteen numbered points of up to about **250 characters** each still fit in Key terms in ordinary English and Bahasa Malaysia (about 220 characters each if written in capitals). Fifteen points of 350 characters, which fitted before, no longer do: if a text is longer than its box, the send is refused with a message naming the box, until you shorten the text or make the box bigger. Nothing is cut off.
- The nine placeholder points of Key terms are unchanged, and the form and its questions do not change.
- Because the template file changed, **Update** adds a new draft template named **“Merchant Application (updated)”** (“(updated 2)” if the copy from an earlier update is still there) and leaves your current one, and every document and draft made from it, exactly as they are. A workspace that stays on version 3.1 keeps its template as it is.

**What version 3.1 changed** (the company stamp, the old registration number and the documents):

- **The merchant can create the company stamp.** On the last step of the form, the stamp has two choices: **Upload your stamp**, as before, or **Create a stamp from your company details**. Creating opens a card with a preview of a round stamp in dark blue ink: the company name round the outer edge, the registration number in the middle, the old registration number in brackets under it, and a small star at the bottom. The preview follows what the merchant types. If the company name or the registration number is not filled in yet, the card says so and has a button to go to each. **Use this stamp** saves it like any picture the merchant uploaded, and the signed copy prints it in the same place as an uploaded stamp. **Remove / choose another way** takes it away again. The card says: “This is a digital imprint made from your company details.” It is not an official seal; a merchant who has a stamp file can still upload it.
- **New question: Old registration number (if any).** It is asked of a Sdn. Bhd., a club, society or co-operative, and Others, and is never required. Write it with letters, digits and hyphens, for example 123456-A (up to 20 characters). It is printed beside the registration number and appears on the stamp. A sole proprietor or a partnership is not asked.
- **The documents step is clearer.** Each document says whether it is **Required for your business type**, **Required** or **Optional**, and a step with several documents says **how many are added** (for example “3 of 5 required documents added”).
- **Part 4 of the printed application lists each document with the name of the file the merchant uploaded.** The list now matches the form for every type of business: a club, society or co-operative also gives a bank statement header, an ID and pictures of the premise. A line stays blank when the document is not needed for the merchant's type. A long file name is shortened to fit on one line, so a merchant never has to rename a file to sign. File names in Chinese, Japanese or Korean print as question marks unless your platform operator has installed the font for them.
- Because the template file changed, **Update** adds a new draft template named **“Merchant Application (updated)”** (“(updated 2)” if the copy from an earlier update is still there) and leaves your current one, and every document and draft made from it, exactly as they are. The new question and the stamp choice are in the new template only.

**What version 3.0 changed** (the commercial terms page, which is Part 5, “Commercial terms / Terma komersial”):

- Part 5 is now just **two boxes of text you write**, instead of thirteen: **Platform fee / Yuran platform** (about a quarter of the page in 3.0 and 3.1, a little under a third since 3.2) and **Key terms / Terma utama** (the rest of the page). The merchant sees both printed and cannot change them.
- **Platform fee** started in 3.0 with one line each for FPX, Credit card, Debit card and the payment channel note, with a marked place for each agreed rate. Since 3.2 it starts with a standard rate text (see above). Replace the text with your own, and add or remove lines as you need.
- **Key terms** starts with nine numbered points, one for each of the old headings (partner, right to decline, information requests, account access, refund and void, termination, binding effect, hardware, settlement). Each is marked “[insert the agreed wording / masukkan perkataan yang dipersetujui]”. Replace them with your agreed wording, and add points up to about **15**, each of up to about 250 characters, in English and Bahasa Malaysia.
- **How to edit them.** Open the template, choose the box, and write in the text area of its properties. Start a new line for each point; a blank line is kept as a blank line, and long lines wrap to the box. The text can be up to **6,000 characters**, and the printed size is the same for every document (8 pt).
- **Text that does not fit is never cut off.** Saving the template warns you that a box would cut its text. If you send anyway, the send is **refused** with a message naming the box, until you shorten the text or make the box bigger. In 3.0 and 3.1 the key terms box held about 49 lines and the platform fee box about 17; since 3.2 they hold 42 and 25.
- Different fees or terms for another group of merchants are another template: duplicate this one.
- **Types of business** are now Sole proprietor, Partnership, Sdn. Bhd., **Club, society or co-operative** and Others. “Bhd.” is gone. A club, society or co-operative uploads its **latest minutes of meeting** (PDF, JPG or PNG, like the other uploads); the list of documents on the page says so.
- **Codes follow the type of business.** A sole proprietor or a partnership gives up to **5 Business codes** (5 digits each). A Sdn. Bhd., a club, society or co-operative, and Others give the **MSIC codes** as before. The one that does not apply is not asked and prints blank, and a small note under the two boxes says which is whose.
- **SST is asked as Yes or No** (“Do you pay SST?”). Only for Yes, the merchant is also asked the **type of tax** (Service tax or Sales tax), the **percentage** (6, 8 or 10) and the **SST registration number**; all three are then required.
- **No longer asked:** the Registration ID type, the Business activity, and the contact person's designation. The registration number stays. (If you submit to LHDN MyInvois, check whether you still need the ID type.)
- **Contacts** are: **Person in charge** (name, email, phone), **Operations responsible** (name, email), **Finance responsible** (name, email) and one **E-invoice and payment receipt email**. All are required. The old e-invoice person in charge and the separate e-invoice email are gone.
- The words next to the “I have read and accept” tick no longer list the nine old headings.
- Because the template file changed, **Update** adds a new draft template named **“Merchant Application (updated)”** and leaves your current one, and every document and draft made from it, exactly as they are. A draft you already started keeps its own thirteen boxes; only documents you start from the new template have two. To move wording across, copy it by hand: the four fee boxes become the four lines of Platform fee, and the nine key-term boxes become points 1 to 9 of Key terms, in the order of the headings above.

**What version 2.0 changed** (for a workspace that installed 1.1):

- State, country, bank, company ID type, e-invoice phase and tax type take their choices from your **shared lists** (Settings, Secure Sign, Lists), so a bank or a state is changed once for every form. See [Option lists](/help/doc-sign/option-lists).
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
