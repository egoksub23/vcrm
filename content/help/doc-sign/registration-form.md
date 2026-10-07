---
title: Registration forms
description: Give new merchants or applicants a public page where they enter a few details and get the document to sign by email, with the contact and the tag made for you.
order: 17
updated: 2026-10-07
---

A **registration form** is a web page anyone can open without logging in. You share its address on your website, in a WhatsApp message or as a QR code. A new merchant enters a few details, and Halo does the rest: it finds or makes their contact, tags it, and emails them the document to read and sign.

The email is the key idea. The document goes only to the address they typed, so opening it proves the address is theirs. Nothing is shown on the page itself except "check your email".

## Make a form

You need permission to manage Doc Sign settings (owners and admins have it by default).

1. Open **Settings > Doc Sign > Registration forms** and click **New registration form**.
2. **Name** it. Only your team sees the name. Below it you see how the address will read: the name, then a random ending that is made when you save. It never contains anything about your workspace.
3. Choose what happens after they submit:
   - **Send a document to sign.** Choose the **template**, and the **role the applicant fills** (for example Merchant). If the template has other roles, such as a director who countersigns, type a name and an email for each. Leave a role empty if nobody is needed for it.
   - **Or keep only the details.** Switch **Send a document to sign** off. The contact is made and tagged, and nothing is sent. This is the way to start a [bulk send or an automation](/help/doc-sign/automate-signing) of your own.
4. Optionally add **People who receive a copy** (only when the form sends a document). They get the signed PDF of every document this form sends. See [People who receive a copy of every document](#people-who-receive-a-copy-of-every-document) below.
5. Choose a **tag** for the contact, for example "Merchant applicant". A tag can start an automation, such as a welcome message. Make the tag first in **Settings > Tags** if you do not have one.
6. Choose which details the page asks for: full name, company, phone. Each can be **Required**, **Optional** or **Not asked**. The email is always asked, because the document goes there.
7. Set the **registrations a day** (the default is 100) and the **language of the page**. A visitor can change the language on the page.
8. Open **Wording** if you want your own agreement text or thank-you message in any of the four languages. Write the workspace name as `{workspace}`. Leave a language empty to use Halo's own words.
9. Click **Create form**.

A new form starts **switched off**. Open its address with **Open** to see the page, then switch **Take registrations** on. Halo will not switch on a form that cannot work, and tells you why: a template that is not active, a role with nobody named, and so on.

> [!NOTE]
> If you also have an automation that sends a document when the tag is added, do not also turn on **Send a document to sign** on the form. The applicant would get two. Choose one of the two.

## People who receive a copy of every document

A registration form that sends a document can carry a **list of people who receive a copy**: for example your finance team, or the person who handles onboarding. Open the form, go to **People who receive a copy**, click **Add a person** and type a name and an email address (or choose a contact for the name). The list is saved with the form, and the form's card shows how many people are on it.

- They are **not signers**. They never get a signing link, and they are not counted in the document's progress.
- Each of them gets **one email with the signed PDF** of every document the form makes, when that document is completed.
- You can add up to **10** people, and each address can be listed once.
- If one of them also signs a document (for example the director you named for another role), they are left out of that document's copies, because they get the signed copy as a signer.
- **The list is never shown on the public page.** The person who registers does not see the names or the addresses, or that the list exists.

A person you started to add but did not finish (a name without an email, or the other way round) stops the form from being saved until you complete or remove them. A form that sends no document keeps no list, because there is nothing to send. See [Receive a copy of the signed document](/help/doc-sign/copies) for what the email holds.

## What the applicant sees

A short page in your workspace's name and logo. It works on a phone: large fields, the right keyboard for email and phone, and the browser's own autofill. They tick the box that agrees to your wording, and press **Send**. Then they see **Check your email**, with the address they typed. The document arrives in the language they used on the page.

Problems are shown next to the field, in their language, for example "Enter the number with its country code". A phone number needs the country code, such as +60 12-345 6789.

## What happens when they submit

- **The contact.** Halo looks for a contact with the same email. If there is one, only its empty fields (name, company, phone) are filled in. Nothing already on the contact is ever overwritten, so typing someone else's email cannot change their record. If there is none, a new contact is made as a lead.
- **A phone number that is already someone else's** is not added. The person gets a new contact without a number, and the pair appears in the list of possible duplicates for your team to look at.
- **The tag** is applied, once.
- **The document** is made from the template, with the company name and the other details typed on the page filled in where the template asks for them, and sent. It counts toward your monthly limit like any other. The history of the document starts with the registration.
- **The same email again** within 24 hours does not start a second document. The person sees the same "Check your email" page, so the page never tells anyone whether an address is already known.

## Keeping spam out

You do not need to do anything. The page limits how often one connection and one form can submit, has a hidden field that real people never see (a script that fills everything is caught by it), and gives every visit a signed ticket that must be genuine and not too old or too new. Each form also has a **daily cap**: when it is full the page says it is busy, and tries again tomorrow.

If you still see spam, ask your platform operator to switch on the **Cloudflare Turnstile** check. It adds a small "I am a person" box to the page.

## See what is happening

Each form has a card in the list with its address (**Copy** and **Open** buttons), how many registrations it took today and in the last 30 days, and **Recent activity**. Activity shows what became of each submission and when, never the person's address or email. The outcomes are:

- **Accepted.** The contact was made and, if the form sends one, the document went out. A repeat within the day says so.
- **Blocked.** The hidden field was filled, the ticket was not genuine, or the check was not passed.
- **Over the daily cap.**
- **Could not be completed.** The reason is written next to it, for example the monthly limit was reached, or the document was made but the email could not be delivered. The applicant is told "we could not send it right now" and your team keeps the details. Open the document from the activity list to resend it.

## If a link was shared where it should not be

Click **New address** on the form's card. The old address stops working at once and shows "this page is not available". The form itself, its settings and its record stay.

## Privacy

The page keeps the details as a contact in your workspace, like any other contact. For each submission Halo also records which version of the agreement wording was shown and agreed to. It does not keep the visitor's internet address or email in readable form, only a scrambled value that lets it count and spot a repeat. Halo's own agreement wording is a starting point: have it read by someone who knows the Malaysian data protection law before real applicants use it, or write your own under **Wording**.

## Tips

- Start with the form switched off, open it on your own phone, and try a test registration with an email you control.
- Put the address in a QR code on your counter or brochure. It is short enough to read aloud.
- Use a separate form for each template or group of merchants. A form is quick to make and each has its own numbers.
- Name the director or the finance contact in the form when the template needs them, so the document never waits for someone to add them.

## Common mistakes

- **Switching on a form that sends a document and an automation that does too.** The applicant then gets two documents. Choose one.
- **Forgetting the country code on the phone number.** The page asks for it, for example +60.
- **Using a template that is still a draft.** Make it active in [Templates](/help/doc-sign/templates) first.
- **Expecting to see the document link.** The page never shows one. It goes only to the email the applicant typed. If they lose it, use the document's own page to resend.
- **Sharing the address in a place anyone can find it and not expecting registrations from strangers.** Anyone with the address can register. The daily cap and the document going only to their email limit the harm; use **New address** if it spreads too far.

## Related pages

- [Templates](/help/doc-sign/templates)
- [Send a document for signature](/help/doc-sign/send-a-document)
- [Receive a copy of the signed document](/help/doc-sign/copies)
- [Forms in parts](/help/doc-sign/forms-in-parts)
- [Categories and add-ons](/help/doc-sign/categories-and-add-ons)
- [Automate signing](/help/doc-sign/automate-signing)
