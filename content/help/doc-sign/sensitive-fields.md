---
title: Sensitive fields
description: Keep ID numbers and bank account numbers private on a form. They are stored encrypted, shown masked to your team, and left out of exports.
order: 24
updated: 2026-10-07
---

Some answers on a form are more private than others: an IC or passport number, a bank account number, a tax ID. Mark such a question as **Sensitive** and Doc Sign looks after it differently from an ordinary answer.

## What changes for a sensitive question

- **It is stored encrypted.** The answer is scrambled before it is saved. Nobody reading the database sees the number.
- **Your team sees it masked.** On the **Progress** tab of a document the answer shows as `•••• 1234`: only the last four characters, and only when the answer is longer than eight characters. A shorter answer shows just `••••`.
- **Showing the full answer is recorded.** The person who needs the number presses **Reveal**. The full answer is shown for 30 seconds and then hidden again, and the document's history records who revealed which question and when. The history never contains the number itself.
- **It stays out of exports and integrations.** The CSV list export, the zip of signed documents and the public API never include answers to sensitive questions. (They do not include answers at all.)
- **It never fills the contact.** A sensitive question cannot also update the contact's name, email or another contact field.
- **The signer's box hides what is typed.** On their phone or computer the signer types into a hidden box, with a button to show it while they check it. The browser is asked not to remember it.

## Mark a question as sensitive

1. Open the template, then **Form**, and choose the question.
2. Turn on **Sensitive (encrypted and masked)**.
3. Choose how it is printed on the signed PDF (below).
4. Save the template. Documents made from the new version use it.

Only questions that a person types can be sensitive: text, longer text, number, email, phone, date and list. A choice, a yes or no, a file and a picture cannot. When you turn it on, a starting value, the lock and the contact field are removed from that question, because they would put the answer in plain sight.

A rule such as "show this only when the ID number is not empty" is fine. A rule that compares the ID number with a particular value is not allowed.

## What the signed PDF shows

The signed document is the record of what everyone agreed to, so by default a sensitive answer **is printed in full** on the places of the PDF you bound it to. The PDF is sent to the signers and kept with the document, so decide whether that is what you want. You can instead choose:

- **Print only the last 4 characters.** The PDF shows `**** 1234`.
- **Do not print.** The answer is kept, encrypted, but is not written on the PDF.

The certificate pages at the end never show an answer.

## Who can reveal an answer

Everyone who can see Doc Sign sees the masked answer. **Reveal** needs its own permission, **Reveal sensitive answers**. Owners and admins have it by default. Sending documents does not give it, so a person can send and follow documents without being able to read the numbers people typed in. An admin can give the permission to a role that needs it, for example a compliance or operations role, in **Settings**; see [Roles and permissions](/help/getting-started/roles-and-permissions). A person without it sees the masked answer and no **Reveal** button. Each reveal counts against a limit of 20 a minute per person.

This permission is only about **Reveal**. It does not change what the signed PDF prints (see above), and a private document is also hidden from people who may not see it. See [Private documents](/help/doc-sign/private-documents).

## Documents already sent

Only answers saved from now on are encrypted. A document that was already sent keeps its answers as they are, and its form cannot change, so a question you mark sensitive later does not affect it.

## Common mistakes

- **Expecting the PDF to hide the number.** It prints in full unless you choose the last 4 characters or none.
- **Marking a choice or a yes or no as sensitive.** Only typed answers can be. Use a typed question if the answer is private.
- **Expecting to export the numbers.** They are not in any export or in the API. Press **Reveal** one document at a time.
- **No Reveal button.** You need the **Reveal sensitive answers** permission. Ask an admin.
- **Using a sensitive answer to fill the contact.** It is not allowed. Keep the contact's own fields as separate, ordinary questions.
- **Losing the encryption key.** The administrator who runs the server must keep it safe. Without it the answers cannot be read, by anyone.

See also [Forms in parts](/help/doc-sign/forms-in-parts), [Audit trail and the sealed PDF](/help/doc-sign/audit-trail-and-sealed-pdf) and [Templates](/help/doc-sign/templates).
