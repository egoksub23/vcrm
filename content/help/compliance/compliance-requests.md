---
title: Compliance requests
description: Handle account closures, withdrawals and account changes with an identity check, a Head of Compliance sign-off, a clock and a record of every step, and raise them from a chat.
order: 2
updated: 2026-10-14
---

Compliance requests is where your team handles the things a customer asks for that carry real consequences: **closing an account**, **withdrawing money**, and **changing account details** (a parent's phone number or email address, or a child's name). Each request has a clock, an identity check, a recommendation from an officer, a final sign-off from the Head of Compliance, a checklist for operations, and a timeline that records everything. It sits in the sidebar as **Compliance**, directly below **KYC review**.

> [!NOTE]
> Compliance is switched on for a workspace by the platform operator; until then there is no menu item. Requests are kept for **seven years** and cannot be deleted.

## Who can do what

An admin sets this in **Settings**, **Roles & permissions**, under **Compliance requests**. Owners and Admins have all of it; nobody else has any until it is granted.

| Permission | What it lets you do |
|---|---|
| **Compliance requests** (menu) | See the menu item and open the list. On its own it does not open a request. |
| **Review compliance requests** | Open requests, record the identity check, review and recommend, add notes, edit details, link tickets, assign, upload documents and close. |
| **Sign off compliance requests** | The Head of Compliance: approve, reject or send a request back, pause the clock, approve despite outstanding dues with a reason. |
| **Reveal bank details in compliance requests** | Show the bank details in full for two minutes. |
| **Carry out compliance requests** | Operations: tick the checklist and mark a request executing or complete. |
| **Manage compliance settings** | Change the request types and the public forms in **Settings**, **Compliance**. |
| **Raise compliance requests** | Choose **Compliance request** in the **Raise ticket** menu of an Inbox conversation, or press **Raise compliance request** on a ticket. It also lets the person send, send again and withdraw the closure form of a request **they raised**. It does **not** need the Compliance menu: the person sees only the reference and status of what they raised. |

A panel you may not use is read-only and says why.

## The list

**Compliance** opens the list, newest request first. The row of numbers at the top counts the open requests that **need an identity check**, are **in review**, are **awaiting sign-off**, are **executing**, are **past their target**, **near the hard stop** or **breached**. Click one to filter the list to it; click it again to clear.

Search finds a request by its reference (`CMP-2026-000014`), the customer's name, email or phone. Filter by type, status, clock, who it is assigned to ("Mine" shows yours), and the dates.

Every row shows the **clock** in words as well as colour: for a closure, for example, **Past target · Day 17 of 14 target · 13 days to stop**.

| Clock | Meaning |
|---|---|
| On track | Before the target (a closure: 14 days from the request date) |
| Past target (amber) | The target has passed |
| Near hard stop (red) | 10 days or fewer before the regulatory stop (a closure: 30 days) |
| Breached (red) | The hard stop has been reached |
| Paused / Finished | Frozen by the Head, or done |

The clock starts on the **request date**. Alerts go to the people who can review or sign off at 10 days, 5 days and at the stop (they appear in **Notifications**).

## Raise a request

For something a customer asked in a chat or on the phone, press **New request**.

1. Choose the **type**: account closure, fund withdrawal, account change (an admin may add more).
2. Enter the customer's name, email and phone (a number like `012-345 6789` becomes `+60123456789`) and the channel.
3. Leave **Requested on** empty, or set the day and time the customer really asked: the clock starts then, and the request records that you set it by hand.
4. Fill in the form. Bank details are stored **encrypted**. A closure needs the three ticks (every child has finished school, every allowance is cancelled, the customer confirms) and the bank name, account number and account holder.
5. Press **Create request**. Documents (such as an authorization letter when the bank account holder's name differs) are added on the request afterwards.

## Raise a request from the Inbox or a ticket

In an Inbox conversation the header has **one** button, **Raise ticket**. If you hold the **Raise compliance requests** permission (and Compliance is switched on for your workspace) it opens a small menu:

- **Technical or information ticket** opens the usual new-ticket window, with the contact and the chat filled in. See [Create a ticket](/help/tickets/create-a-ticket).
- **Compliance request** opens the dialog below.

If you do not hold the permission, or Compliance is off, **Raise ticket** is the single button it always was. A ticket has its own **Raise compliance request** button.

1. Choose the **type**: **Account change**, **Withdrawal** or **Account closure**. The customer's name, phone and email come from the contact; correct them if they are wrong. How the request arrived is the conversation's channel.
2. Write a **Description** (optional): it is added to the request's timeline for the team.
3. Fill in the type's fields.
   - **Account change.** Choose **what is changing**: the parent's phone number, the parent's email address or a child's name. Then enter the current and the new value (for a child: which child, by their current name, and the new name). Phone numbers like `012-345 6789` become `+60123456789`; email addresses are checked. **A parent's name cannot be changed here**, and the dialog says so.
   - **Withdrawal.** The amount, the reason, the bank details.
   - **Account closure.** See the next section: normally you send the customer the closure form instead of typing their bank details.
   **Tick a box only if the customer has confirmed it to you.**
4. **When the customer asked** is *Now*. Choose *Earlier* only if the customer really asked earlier; you must give the date, the time and why, because the request's clock starts then and the reason is written on the request.
5. Tick **Email the customer a confirmation** if you want them to get one (it needs an email address).
6. Press **Raise request**. A line, **Compliance request CMP-2026-000014 raised**, is added to the conversation as an internal note, or to the ticket as a comment. Everyone who can open it reads that line; only people who hold the Compliance menu see it as a link.

You cannot raise a second request of the same type for a customer who already has one open. If you hold a compliance permission the message names it; if not, it only says one is already open, so that raising can never be used to find out whether someone has a request.

After you raise it you see a small chip on the conversation or ticket, for example **CMP-2026-000014 · In review**, and a short list, **My raised requests**, with the reference, the type and the status of what **you** raised. You never see the customer's answers, bank details or reasons unless you also hold a compliance permission. The words in the chip are: Received, In review (identity check, officer review and sign-off), In progress (approved and being carried out), Done, Not approved and Closed.

## Send the closure form in the chat

For an **account closure** raised from a conversation, the dialog has the box **Send the closure form to the customer in this chat**. It is ticked when the chat can take it. Ticked, you do not enter the ticks or the bank details: the customer does.

1. Press **Raise request**. The request is created **first**, so it exists whatever happens next, with its clock running from the request time.
2. A personal link is made and sent into the chat as a **card**: the title *Account closure form*, one line asking the customer to open the form and fill in their details, and a button (*Open closure form*) in the customer's language (the contact's language, else English). It is a tappable card, not a long web address.
3. In your Inbox the card shows a status line: **Sent**, **Opened**, **Submitted**, **Expired**, **Withdrawn** or **Replaced**. It never shows the address.

**What the customer does.** They tap the button and see the closure form: the same one as the public closure form, with the two required ticks, the bank account, the authorization letter if the bank account holder's name does not match their name, and the declaration. There is **no code to enter**. Their name is filled in from your contact (they can correct it), they **type their email address**, and their registered phone number is shown **masked** (for example `+6012•••••881`) and cannot be changed: it is the number they are chatting with you on. When they submit, they see the reference and what happens next.

**What you see.** The form updates the request you raised (it does not make a second one): the answers are on it, the bank details encrypted like any other. The officer still does the identity check, which is **not** done by the form. The people who review closures get a notification, and the conversation gets an internal note **Closure form submitted · CMP-2026-000014**.

**If it cannot be sent in the chat.** The request is still created, and a message tells you why, with **Copy link**:

- **WhatsApp and the 24 hours.** A message with a button can only go inside the 24-hour window that starts with the customer's last message (the timer in the chat header). When it has run out, Halo does not send anything; copy the link and share it another way, or send the form again when the customer has written to you. Sending is always **your** choice: Halo never sends it by itself and does not use a WhatsApp template for this.
- **A channel that cannot carry it.** The web chat cannot, because anything sent there is stored in the conversation and the link is never stored.
- **A failure.** If the channel refuses the message, you are told and can copy the link or press **Send again**.

The link is shown to you **once**, in that message, and is not kept anywhere. If you lose it, send the form again.

**How each channel shows it.** WhatsApp: a message with a button. Messenger and Instagram: a card with a button. Email and Gmail: an email with a button (and the address under it). The in-app chat channel: one line, *Account closure form: address*, because that channel has no button. The web chat: not sent (copy the link).

**Send again, and withdraw.** On the card in the chat, or on the request in the **Closure form link** panel, **Send again** makes a new link and the old one stops working at once; **Withdraw** stops the link without sending another. A link works **once**, for **14 days**, for that customer only. If the customer has already filled in the form, or the request has moved on to the Head of Compliance, it cannot be sent again. If you hold only the *Raise compliance requests* permission you can do this for the requests you raised; the officers and the Head can do it for any request. Everything is recorded in the request's timeline (made, sent, sent again, opened, withdrawn, submitted), without the address.

**If the customer opens an old link.** They see one calm page: *This link is not valid any more. Please contact support.* It does not say whether the link was used, withdrawn, replaced or expired.

## Public forms: what the parent sees

Parents no longer need the old Airtable form. An administrator switches on a form in **Settings**, **Compliance**, **Public forms**, copies its address and shares it (in a message, an email or on a website). The parent:

1. Opens the address on their phone, chooses English, Bahasa Melayu, Chinese or Korean, and enters their **email address**. We send a 6-digit **code** to it (valid 15 minutes, five tries, three codes an hour). Nothing reaches the workspace until the form is submitted.
2. Fills in the form. **Account closure**: their name, their registered phone number in the `+60` form, whether they want to close the account (*No* creates nothing and shows "No request was made"), two required ticks (every child has finished school; every allowance is stopped and cancelled in the app), the bank for the refund (chosen from a list), the account number and the account holder's name, and a declaration. The page warns that closing closes both the Parent (Principal) and every Child (Supplementary) account for good, and that closing only a Child account goes through Customer Support. **Fund withdrawal** (not a closure): name, phone, amount in RM (up to the limit you set), why (over top-up or another reason), transaction references, an optional proof, the bank details and the declaration.
3. If the **name on the bank account does not match the account holder's name given at the top of the form** (ignoring capital letters, spaces, punctuation, titles such as Encik, Puan or Dato' and *bin* / *binti*), the form requires an **authorization letter** (PDF, JPG or PNG, up to 10 MB).
4. Presses **Submit**. They see a confirmation with the **reference** and a plain "what happens next". They are told we **aim to complete a closure within 14 days** of the request; the regulatory stop is never mentioned to customers.

What arrives in Compliance: a request of source **Form** (channel *web form*), the customer's email marked **confirmed by code**, the bank details **encrypted** like any other, the letter in the private store, and the language the parent chose. The identity check is **not** done: your officer does it as for every request. If the email or the phone number matches exactly one contact of your workspace the request is linked to it; otherwise it is not linked (you can link it on the request). The form never creates a contact.

A parent who submits again while their request of the same type is still open gets the same confirmation and no second request is created. A rejected or finished request does not stop a new one.

## Emails to the customer

All emails go out from your workspace's connected mailbox when it has one, otherwise from the platform sender, in the customer's language (the language chosen on the form, else the contact's, else English). They never contain bank details, the full phone number, a file or a link to a screen of your team.

| Email | When |
|---|---|
| **Confirmation** | When a parent submits the form. For a request you create or raise, tick **Email the customer a confirmation** (on by default when there is an address). |
| **More information needed** | When you press **Ask for more information** in the **Emails to the customer** panel. Write what you need, **preview** it, then send. It is recorded with your name. Do not write bank account numbers or phone numbers: they are refused. |
| **Approved** | Off unless you tick *Tell the customer it is approved* when you approve. |
| **Not approved** | When the Head of Compliance rejects: a **category** (for the reports) and **what the customer is told** are required, separate from the internal note; **preview** it, and untick the box if you do not want it emailed. |
| **Completed** | When Operations presses **Mark complete** (the tick is on by default). |

Each email is sent **once**: a double click or a retry never sends it twice. If one cannot be delivered (for example the mailbox needs reconnecting) the request still moves, the panel shows **Not sent** with the reason in words, and you can press **Send again**. When a request reaches the Head of Compliance, the people who can sign it off get a notification and an email (not the person who did the identity check, who cannot sign it off); the people who can review or sign off also get an email for the 5-days-to-the-stop alert and when the stop is reached (the 10-day alert is a notification only).

## Reports

**Compliance**, **Reports** (for officers and the Head) shows the requests made in a period you choose (the last 30 or 90 days, this year, all time, or your own dates): counts by type and status; for the requests with a clock, how many were completed **within the target**, **after it but within the stop**, **after the stop**, or are **still open past the stop**; the average and median days to a decision and to completion; sign-offs by person; rejections by category; and the age of the open requests. **Export CSV** gives up to 5,000 requests with the reference, type, source, status, dates, days and outcome. **No name, phone number or bank detail is in the report or the file.** Every export is recorded with who made it and the filters.

## The number on the menu

The **Compliance** item in the sidebar shows a number for the people who can act: the Head of Compliance sees the requests awaiting their sign-off (not one whose identity check they recorded); officers see the requests waiting for an identity check or a review. It disappears at zero.

## Work a request

Open a request to see where it is on the bar at the top: **Received, Identity check, Officer review, Sign-off, Execution, Closed**.

1. **Identity check.** Check the person is the account holder (a call back to the registered number, a video call, an ID document, a verification in the chat, in person, or another way you describe), choose **Verified** or **Not verified** (a note is required if not), and press **Record identity check**. **You are recorded as the person who checked.**
2. **Account standing** (closures). Record whether the customer owes anything. For now you enter this by hand; later it will be filled in from the back office.
3. **Officer review.** Choose a recommendation (approve, reject, more information needed) with notes, and press **Submit for sign-off**. You cannot recommend approval after a failed identity check.
4. **Sign-off.** The Head of Compliance presses **Approve**, **Reject** (an internal note, a reason category and the words the customer is told are needed) or **Send back to the officer** (a note is needed). **The person who recorded the identity check cannot sign the same request off**: the buttons are switched off and the page tells you why. A closure with dues outstanding can only be approved if the Head types a reason.
5. **Execution.** Operations ticks each step of the checklist (for a closure: close the account in the back office, refund the balance, tell the customer), with their name and the time recorded. **Mark complete** works when every step is ticked.
6. **Close.** Tell the customer, then **Close the request**. A request that was rejected is closed the same way. A duplicate, or one the customer withdrew, can be **closed without a decision** with a reason, before the sign-off.

You can add **notes** at any time in the timeline. The answers and the customer's details can be edited until the request goes to the Head of Compliance.

## Bank details

Bank and other protected details show **masked**, for example `•••• 9012`. With the reveal permission, **Reveal** shows them in full for **two minutes**, then they hide again; they also hide if you switch to another tab or press **Hide now**. Every reveal is written to the timeline.

## Documents and links

Upload PDF, JPG or PNG files (up to 10 MB each) in **Documents**. They are stored privately and cannot be removed. Opening one is recorded. In **Links** you can open the linked contact, chat, ticket, incident or KYC check, and link a ticket, incident or contact by searching for it.

## Pausing the clock

Where an admin has allowed it for the request type, the Head of Compliance can **pause the clock** with a reason, and **resume** it. Resuming moves the deadlines later by the time paused. It is off by default; a pause is always recorded.

## Every step is recorded

The **Timeline** lists everything, newest first: who opened the request, every status change, the identity check, the recommendation, the decision, each checklist tick, each reveal, each file, each edit and each alert. Nobody can edit or delete a line. Repeated opens by the same person within ten minutes are shown as one line.

## For administrators: Settings > Compliance

Each request type has its name (also in Malay, Chinese and Korean), the **target** and **hard stop** in days (leave empty for none), whether it needs an identity check, checks account standing or allows a pause, whether it is on, and its **operations checklist**. Changing the clocks affects **new requests only**. The fields of the three standard types are fixed; you can add your own types with their own fields.

### Public forms

Under the request types, **Public forms** has one card for the account closure form and one for the fund withdrawal form (a phone number change is only ever raised by staff). For each:

- **Accept requests through this form** switches it on or off. When it is off, or when your workspace does not have Compliance requests switched on, anyone who opens the address sees "This form is not available".
- **Address to share**: random, so it cannot be guessed. **New address** stops the old one working at once.
- **Extra notice above the form**: optional text for each language; a language left empty shows the English text.
- **Turnstile**: a Cloudflare check when a parent asks for a code. It is available only when the operator has set the Turnstile keys for the server.
- **Largest amount accepted** (withdrawal form) and the **banks in the list** (one per line; empty uses the built-in list of Malaysian banks; *Other bank* is always offered).

To try a form safely, switch it on in a **test workspace** (see the operator notes in `docs/compliance-requests.md`), use an email address you control, and complete a request: it appears in the list marked as coming from the form. Close it without a decision (a note is required) when you have finished testing.
