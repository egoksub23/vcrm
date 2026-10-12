---
title: Compliance requests
description: Handle account closures, withdrawals and phone number changes with an identity check, a Head of Compliance sign-off, a clock and a record of every step.
order: 2
updated: 2026-10-13
---

Compliance requests is where your team handles the things a customer asks for that carry real consequences: **closing an account**, **withdrawing money**, and **changing the phone number** on an account. Each request has a clock, an identity check, a recommendation from an officer, a final sign-off from the Head of Compliance, a checklist for operations, and a timeline that records everything. It sits in the sidebar as **Compliance**, directly below **KYC review**.

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
| **Manage compliance settings** | Change the request types in **Settings**, **Compliance**. |

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

1. Choose the **type**: account closure, fund withdrawal, phone number change (an admin may add more).
2. Enter the customer's name, email and phone (a number like `012-345 6789` becomes `+60123456789`) and the channel.
3. Leave **Requested on** empty, or set the day and time the customer really asked: the clock starts then, and the request records that you set it by hand.
4. Fill in the form. Bank details are stored **encrypted**. A closure needs the three ticks (every child has finished school, every allowance is cancelled, the customer confirms) and the bank name, account number and account holder.
5. Press **Create request**. Documents (such as an authorization letter when the bank account holder's name differs) are added on the request afterwards.

## Work a request

Open a request to see where it is on the bar at the top: **Received, Identity check, Officer review, Sign-off, Execution, Closed**.

1. **Identity check.** Check the person is the account holder (a call back to the registered number, a video call, an ID document, a verification in the chat, in person, or another way you describe), choose **Verified** or **Not verified** (a note is required if not), and press **Record identity check**. **You are recorded as the person who checked.**
2. **Account standing** (closures). Record whether the customer owes anything. For now you enter this by hand; later it will be filled in from the back office.
3. **Officer review.** Choose a recommendation (approve, reject, more information needed) with notes, and press **Submit for sign-off**. You cannot recommend approval after a failed identity check.
4. **Sign-off.** The Head of Compliance presses **Approve**, **Reject** (a reason is needed) or **Send back to the officer** (a note is needed). **The person who recorded the identity check cannot sign the same request off**: the buttons are switched off and the page tells you why. A closure with dues outstanding can only be approved if the Head types a reason.
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
