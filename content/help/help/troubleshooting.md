---
title: Troubleshooting
description: Common problems, with what you see, why it happens and how to fix it.
order: 1
updated: 2026-09-21
---

Find your problem by the words you see on screen. If the fix does not work, tell your admin what you did and what the message said.

## I cannot send a message

### The reply box says "Session expired - use a template"

**Why:** WhatsApp only lets you write freely for 24 hours after the customer's last message. The chat header shows how long is left, or **Expired**. The box shows: 24-hour session expired. Use a template to re-engage.

**Fix:** Click **Templates** (or **Send template**), pick an approved template, fill in the placeholders and send it. When the customer replies, you can write freely again. If the list says **No approved templates**, ask your admin to approve and sync one. See [Reply to customers](/help/inbox/reply-to-customers).

### The reply box says "Read-only — viewers can browse but not reply"

**Why:** Your role cannot send messages. A Viewer never can, and an admin can also switch it off for other roles.

**Fix:** Ask your admin. See [Roles and permissions](/help/getting-started/roles-and-permissions).

### A message shows "Not sent"

**Why:** The channel refused the message, or Meta accepted it and then could not deliver it. Vircle CRM keeps the message in the chat with a red **Not sent** panel. The panel says why in plain words and what to do. Press the small **i** button to see the provider's own message and error code.

**Fix:** Do what the panel says. For example, send a template when the 24-hour window has closed, ask your admin to reconnect the channel when the connection has expired, or wait a moment when it says you are sending too fast. Then press **Resend** on the message. It sends the same thing again and replaces the red message, so the customer never gets two. If the 24-hour window has closed, **Resend** opens the templates instead of trying again. Press **Delete** to remove a message you no longer want to send. If the same reason keeps coming back, send your admin the exact words and the error code. See [Reply to customers](/help/inbox/reply-to-customers).

### My voice note is silent, or the microphone does not work

**Why:** The browser may be using the wrong microphone, or it has no permission.

**Fix:** While you record, open the **Microphone** menu and pick another one. Watch the level meter. If you see "No sound detected. Pick a different microphone below.", choose a different microphone. If you see "Microphone access denied or unavailable.", allow the microphone for this site in your browser settings.

## I cannot find something

### I cannot find a chat

**Fix:**
1. Check the tab. **Chats** and **Emails** are separate, and **Comments** has its own tab.
2. Look at the filters. **Mine**, **Unassigned**, **Unread**, **Open**, **Pending** and **Closed** each hide chats. Click **Clear all**.
3. Check the channel, tag, label and team dropdowns.
4. Type the name or number in **Search conversations...**.
5. Remember that a chat is removed when its contact is deleted.

See [Inbox overview](/help/inbox/inbox-overview).

### I cannot find a contact

**Fix:** Click **Clear all** if a tag filter is on. Search only looks at name, phone and email, and matches a phone number as it was typed when saved, so try fewer digits. The list shows 25 contacts per page. See [Contacts overview](/help/contacts/contacts-overview).

### A ticket is missing from the board

**Fix:** Closed tickets are in the folded **Closed** column. Click **Show Closed tickets**. Click **Clear filters** if a filter is on. If a column is long, click **Show more**. In the list, click **Load more**. Search and filters only cover the tickets that are loaded.

### An article does not appear in the Knowledge tab

**Why:** Only **Published** articles are found. A draft is not.

**Fix:** Ask a reviewer to publish it. Try a word the customer used. Check the article's language. See [Use articles in a chat](/help/knowledge/use-articles-in-chat).

## A button or menu is missing, or greyed out

**Why:** Your role does not have that permission. When you point at a greyed-out button, it says "Read-only — your role can't …". A menu can also be hidden for your role.

**Fix:** Ask your admin. Say what you tried to do. Common examples: an Agent cannot publish articles, delete tickets, set up channels or open Approvals by default. See [Roles and permissions](/help/getting-started/roles-and-permissions).

## My tag, label or snippet is not in the list

**Why:** It is **Pending**. A reviewer has to approve it first, and until then only you and the reviewers can see it.

**Fix:** Wait, or ask a reviewer. See [Approvals](/help/working-together/approvals).

## I cannot publish my article

**Why:** Articles you write are saved as drafts. An admin publishes them.

**Fix:** Save the draft, then tell your admin. See [Write and edit articles](/help/knowledge/write-and-edit-articles).

## The AI does not work

### "AI isn't set up yet" or "AI is not set up"

**Why:** Your admin has not finished setting up AI.

**Fix:** Write the reply yourself, and ask your admin.

### "The AI budget for this month is used up"

**Why:** The monthly limit for AI is finished. Drafts, notes and summaries stop until next month or until an admin raises the limit.

**Fix:** Write the text yourself. Tell your admin. See [AI assistance](/help/inbox/ai-assistance).

## Contacts and imports

### The phone number is refused

**Why:** One phone number can belong to only one contact. In the Inbox you may see "Another contact already uses this number.", or "Use 7–15 digits, with an optional + at the start."

**Fix:** When you edit a contact, the message names the other contact that has the number. Otherwise, search for the number on the Contacts page. If it belongs to a duplicate, see [Merge duplicates](/help/contacts/merge-duplicates).

### The import says "No valid rows found"

**Why:** The file has no `phone` column, or the header row is missing.

**Fix:** Put a header row first, with a column called `phone`. See [Import contacts](/help/contacts/import-and-export).

### The import says "Unknown tags skipped"

**Why:** Your file used tag names that do not exist yet, and your role cannot create tags.

**Fix:** Ask your admin to create the tags, then add them to the contacts.

## Tickets and Jira

### I cannot create a ticket

**Why:** The **New Ticket** button is greyed out, or says "You have read-only access to tickets". Your role is read-only for tickets. Or you see "Fill in the required fields": a required extra field is empty.

**Fix:** Ask your admin about the role. Or fill in the marked fields. See [Create a ticket](/help/tickets/create-a-ticket).

### A ticket will not move to Resolved or Closed

**Why:** Your workspace needs a resolution when a ticket is resolved or closed. You cancelled the "How was this resolved?" window, or the message says "A resolution is needed to resolve or close a ticket". The window also cannot be confirmed when the list of resolutions is empty.

**Fix:** Move the ticket again and choose a **Resolution**. If the list is empty, ask your admin to add resolutions in **Settings**, **Ticket form**. See [Work a ticket](/help/tickets/work-a-ticket).

### A ticket has no SLA badge

**Why:** No SLA rule matches this ticket. That is normal.

**Fix:** Nothing is wrong. Your admin decides which tickets get an SLA.

### The Jira section is missing, or says Jira needs to be reconnected

**Fix:** Ask your admin to connect or reconnect Jira. See [Jira link](/help/tickets/jira-link).

## Other

### I do not get pop-up alerts for new messages

**Fix:** Click **Settings**, then **Your profile**, then turn on **Browser notifications**. Allow notifications when your browser asks. It works only while the app is open in a tab, and only on the device where you switched it on. See [Notifications](/help/working-together/notifications).

### A broadcast stopped part-way

**Fix:** Open the broadcast and click **Resume sending**. Keep the tab open next time. See [Broadcasts](/help/working-together/broadcasts).

### A page shows "Could not load" or stays blank

**Fix:** Click **Retry**, or refresh the page. If it keeps happening, tell your admin and say which page it was.

### I deleted a contact by mistake

**Why:** A deleted contact cannot be brought back, and their chats and tickets go with them.

**Fix:** Tell your admin at once. If nothing can be restored, add the contact again.
