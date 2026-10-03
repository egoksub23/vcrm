# Audited support access

How the platform operator helps a customer **without being able to read their data**. Migration 154.

## The rule

The operator can look at **diagnostics** of a workspace only while its **owner** has allowed it, for 1 hour to 7 days,
and every look is written to a log the workspace's admins can read. Nothing else gives an operator a view into a
customer workspace (the operator's own login belongs to their own workspace, so every table policy keeps them out).

| | |
|---|---|
| Who can allow it | the workspace owner, in **Settings > Workspace > Support access**; optionally for one named operator |
| For how long | 1 hour, 4 hours, 1 day, 3 days or 7 days; ends by itself; the owner can end it sooner |
| What the owner sees | a notice above every page for admins while it is on, the list of grants, and **every time support looked** (who, which part, when) |
| What the operator sees | six sections: **overview** (plan, limits, features, status, member/contact/conversation counts), **channels** (enabled, status, needs re-authorising, expiry dates), **failed sends** (last 7 days grouped by channel and error code, with counts and no text), **members** (count by role, seen in 7 days, pending invitations), **background jobs** (counts by status), **usage** |
| What the operator never sees | conversations, messages, contacts, names, email addresses, phone numbers, files, tokens, signing secrets, provider error text |

## How it is enforced

- Every answer comes from `platform_support_view(account, section)`, a database function with a **fixed list of fields**
  per section. There is no way to ask for another field or table. It first checks the caller is a platform operator and
  that an unexpired, unrevoked grant exists for them (a grant can name one operator), and gives the **same refusal**
  whether the workspace exists or not.
- The log row is written **inside the same function, before the answer**, with no error handling: if the log cannot be
  written, nothing is returned. The log is append-only (the same trigger approach as the audit trail) and only goes away
  with the workspace.
- Grants and the log cannot be written directly by anyone (no write policies); only the functions write.
- `verify-154-support-access.sql` plants a contact name, an email, a phone number, a message text, a failed-message text,
  a WhatsApp access token and verify token in a workspace, opens all six sections, and **fails if any of them appears**.

## For the operator

Operator console: a workspace shows a **Support view** button while access is allowed (hover for the end time). It opens
the six sections; each one you open is logged. Ask the customer's owner to turn it on in Settings if the button is missing.
