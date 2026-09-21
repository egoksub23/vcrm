---
title: Roles and permissions
description: What you can and cannot do by default as an agent, why a button or menu can be missing, and who to ask.
order: 3
updated: 2026-09-21
---

Everyone in Vircle CRM has a role. Your role decides which screens you see and which buttons you can use. This page explains what that means for you.

## The four roles

| Role | In short |
|---|---|
| **Owner** | Full control of the workspace. Cannot be limited. |
| **Admin** | Runs the workspace: channels, AI setup, team and settings. Can also do everything an agent can. |
| **Agent** | Works with conversations, contacts, deals, tickets and broadcasts. Cannot change workspace settings, channels or members. |
| **Viewer** | Read-only. Can look, but cannot change anything. |

Your role is shown next to the workspace name at the bottom of the sidebar, when your workspace has a name that differs from yours.

> [!IMPORTANT]
> Admins can change what each role is allowed to do. What follows is the **default** for an agent. Your workspace may be set up a little differently. If something here does not match what you see, ask your admin.

## What an agent can do by default

- **Inbox:** send replies, add internal notes, assign, close and reopen chats, change priority, apply labels, save personal inbox views, and reply to public comments (hide, resolve).
- **Contacts:** edit contacts, add tags to a contact, write contact notes, and merge duplicate contacts.
- **Deals and broadcasts:** create deals, move them between stages, and send broadcasts.
- **Tickets:** create and update tickets and comment on them. Link tickets to Jira and share notes to Jira.
- **AI:** ask for AI reply drafts, conversation summaries and closing-note drafts.
- **Knowledge:** write your own draft articles. Someone with publish rights must approve them before they go live.
- **Quick replies:** add your own quick replies (they appear under **Snippets** in the reply box).
- **Tags and labels:** suggest new ones. They go live when a reviewer approves them.

## What an agent cannot do by default

- Change channels, message templates, AI setup, API keys or the workspace name.
- Create or edit tags and labels without approval.
- Publish knowledge articles or manage collections.
- Delete public comments or delete tickets.
- Save inbox views that the whole team sees.
- Edit pipelines and their stages, the ticket form, or SLA and business hours.
- Invite, remove or change members, manage teams, or change roles.
- Approve proposals or read the audit log.

A **Viewer** can open the menus they are given and the Reports page, and nothing else. The reply box says "Read-only — viewers can browse but not reply".

## Why a button or menu can be missing

| What you see | What it means |
|---|---|
| A sidebar item is missing | Your role does not include that page. Your admin can switch it on. |
| A page says "You don't have access to this page" | The same thing, when you open the page by a link. Use the button on the page to go somewhere you can open. |
| A button is greyed out, and pointing at it shows "Read-only — your role can't ..." | You can see the feature but not use it. The tooltip finishes the sentence, for example "send messages". |
| A button or link does not appear at all | It is for a role above yours. Example: the **Manage** link next to contact fields. |
| The sidebar is empty for a moment after you open the app | Your permissions are still loading. Wait a second. |
| A message "Could not load your permissions" with a **Retry** button | Vircle CRM could not read your role, so it treats you as read-only until it can. Check your connection and press **Retry**. |
| A message "This user is not linked to an account" | Your login is not attached to a workspace. Ask the owner to send the invitation again. |

## Who to ask

Ask an **Owner or Admin**. Tell them exactly what you were trying to do and what you saw, for example: "I could not press Merge in a chat. The button was missing."

When an admin changes your permissions, you get the change the next time a page loads or gets focus, or within about 2 minutes. You do not need to sign out.

## Tips

- If a button is greyed out, hover over it first. The tooltip usually tells you which action your role cannot do.
- Some things need a second person. For example, a tag you suggest is approved by someone else. See [Approvals](/help/working-together/approvals).

## Common mistakes

- **Assuming a missing button is a fault.** It is usually a permission.
- **Asking for more access without saying why.** Tell your admin which task is blocked, so they can switch on only what you need.

## Next steps

- [A tour of the screens](/help/getting-started/screen-tour)
- [Troubleshooting](/help/help/troubleshooting)
