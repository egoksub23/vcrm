# Compliance requests: spec

Status: agreed with the owner, not built. Build starts after the KYC review (`docs/kyc-review-plan.md`) ships, because both use the same feature switch, permissions pattern and access log.
Menu: a **Compliance** area with Incidents, Requests and KYC review. Route: `/compliance`. Reference format: `CMP-2026-000001`.

## 1. Why a third kind of case

- A **ticket** is a support conversation that every agent sees. A compliance request carries a child's identity and bank details and needs a regulatory clock, evidence and sign-off.
- An **incident** is something that went wrong, open to every role. A request is a customer's instruction we must act on, visible to a small group.

Requests link to tickets, incidents, contacts and KYC validations; they are never bundled into them.

## 2. Request types (phase 1)

| Type | Comes from | Key data |
|---|---|---|
| Account closure | public parent form; or raised from a chat or ticket | holder name, email, registered phone (`+60…`), confirmation to close, ticks that every child has finished school and every allowance is cancelled, bank name / account number / holder name for the refund, authorization letter if the bank holder name differs |
| Fund withdrawal (not a closure) | form or chat | holder name, phone, amount, reason (for example an over top-up), transaction references or proof, bank details, authorization letter if the names differ |
| Phone number change | a customer-care chat, raised by an agent | current phone, new phone, channel, link to the conversation, how identity was verified (method, who, when, notes) |

New types can be added later without code: each type is a definition of fields, required checks and a checklist.

## 3. Rules agreed with the owner

Confirmed by the owner: the **Head of Compliance** gives the final sign-off (the Officer prepares and recommends), and the **parent form collects bank details** (encrypted, masked until revealed).

- **Closure clocks:** practice target **14 days** from the request date; regulatory hard stop **30 days**. The case shows both: amber after the 14-day target passes, red and an alert as the 30-day stop approaches (10 and 5 days left) and on breach. Withdrawals and phone changes have no stated clock yet: configurable per type, default none.
- **Sign-off:** two roles, **Compliance Officer** (does the identity check and review, recommends) and **Head of Compliance** (final sign-off; may also act as officer). The person who did the identity check cannot sign the same case off.
- **Refuse incomplete closure forms:** the parent form will not submit unless the school-completion and allowance ticks are present.
- **Outstanding dues:** a later integration with the Vircle back office. Phase 1 has an "Account standing" block on a closure case with a manual yes/no and notes; when the API arrives it fills in automatically and can block approval while dues exist.
- **Identity check on a chat-raised request:** phase 1 is a checklist (method, verified by, when, notes). Later, an ID verification flow inside the chat produces a record linked to the case.
- **Execution is manual** for now: a checklist for the operations person (close in back office, refund, confirm), each step ticked with who and when.
- **Retention: 7 years**, never deleted by Halo. Every step, view, reveal and decision is logged.
- **Visibility:** only holders of the compliance permissions and the person who raised the case.

## 4. Workflow

Received → Identity check → Officer review → Head of Compliance sign-off → Approved or Rejected → Executed by operations → Customer told → Closed.

- Rejected needs a reason that is sent to the customer in the case's language.
- "More information needed" pauses the clock only if the owner decides so (default: the clock keeps running; a pause is a deliberate, logged action by the Head of Compliance).
- Each transition records who, when and a note.

## 5. Intake

1. **Public parent form** replacing the Airtable form: same fields plus bank details, an emailed verification code (so the parent controls that address), spam protection (Turnstile is already available for registration pages), and a confirmation page with the case reference. Later the same form can be embedded in a chat with validation.
2. **Raise from Inbox or a ticket:** a button carries the contact, conversation link and details across; the ticket gets a link to the case.

## 6. Permissions and data protection

| Permission | Holder by default |
|---|---|
| `menu.compliance`, see the area | Head of Compliance, Compliance Officer, Owner, Admin |
| `compliance.review` | Compliance Officer, Head of Compliance, Owner, Admin |
| `compliance.approve`, sign-off | Head of Compliance, Owner |
| `compliance.reveal`, see bank details and full identifiers | Compliance Officer, Head of Compliance |
| `compliance.execute`, tick the operations checklist | an Operations role, configured by an admin |

- Platform switch `compliance` (off for every workspace until turned on for Vircle).
- Bank account numbers and identifiers are encrypted at rest and masked until revealed; each reveal is logged. The parent's uploaded letters are stored in a private bucket, never public.
- A case's audit trail is append-only.

## 7. Notifications

From the workspace mailbox: received (with the reference), more information needed, approved, rejected, completed. Internal alerts to the Head of Compliance when a case nears its stop date.

## 8. Reports

Cases by type and status; time to decision; closures against the 14-day target and 30-day stop; breaches; sign-off by person. CSV export for audit, 7-year retention noted.

## 9. Not in phase 1

Vircle back-office APIs (dues check, executing the closure), the chat-embedded form and ID verification, automatic withdrawal payouts.

## 10. Open items

- The deadline for withdrawals and phone changes, if any.
- The text of the customer emails and the parent form in English, Malay, Chinese and Korean.
- Whether "more information needed" should ever pause the clock (default: it does not).
