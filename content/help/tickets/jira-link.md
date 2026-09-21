---
title: Jira link
description: Create or link a Jira issue from a ticket, and see its live status.
order: 4
updated: 2026-09-21
---

Some teams track engineering work in Jira. If your workspace has connected Jira, you can create a Jira issue from a ticket, or link a ticket to an issue that already exists. The ticket then shows the issue's live status, so you do not need to ask the engineers.

## Before you start

The Jira section on a ticket appears only when your admin has connected Jira. If you do not see a **Jira** section, ask your admin. Connecting and changing Jira settings is an admin task, and not covered here. If you see "Ask a workspace admin to reconnect Jira", tell your admin. Syncing is paused until they do.

By default an Agent can create, link, unlink and move Jira issues, and can share notes. If the buttons are greyed out, your role does not have that permission. See [Roles and permissions](/help/getting-started/roles-and-permissions).

## Create a Jira issue from a ticket

1. Open the ticket and find the **Jira** section.
2. Click **Create issue**. A window called **Create Jira issue** opens.
3. Choose the **Project** and the **Issue type**.
4. Set the **Priority**, or leave **Default (from the ticket)**.
5. Search for an **Assignee** if you want one. It is optional.
6. Add extra **Labels** if you like. The label "vircle" is always added.
7. Fill in any fields marked **Required by this project**.
8. Read **What will be sent to Jira**. It shows the Summary and Description.
9. Click **Create issue**. You see "Created KEY in Jira".

> [!IMPORTANT]
> Read the preview before you click **Create issue**. Jira issues may be visible to people outside your support team. The preview tells you whether the customer's name and email are included. They are left out unless your admin turned them on. Never add private details to a ticket that you would not want Jira users to read.

If the project needs fields that Vircle cannot fill, the window says so and offers **Open in Jira instead**. Create the issue in Jira then, and link it back.

## Link an existing issue

1. In the **Jira** section, click **Link existing issue**.
2. Paste the issue key (for example ENG-482) or the link. You can also type words from the title to search.
3. Click the issue, then **Link issue**.

A ticket can link up to five Jira issues. The same Jira issue can be linked from several tickets. Comments that were already in Jira are not brought across. Only new ones are.

## The Jira card

Each linked issue has a card with its key (click it to open the issue in Jira), its status (To do, In progress or Done), the assignee, the reporter, the priority and the resolution. The buttons are:

- **Sync now** fetches the latest information.
- **Open in Jira** opens the issue.
- **Move Jira issue to…** changes the issue's status in Jira, when Jira allows it.
- **Comment in Jira** posts a comment to the issue. It is also kept as a note on the ticket.
- **Unlink** removes the link. Nothing is deleted in Jira.

The Jira key also shows as a small chip on board cards and list rows.

## Live status and notes

When someone changes the status in Jira, the ticket can follow. You see a line in the activity such as "Jira moved this from … to … (KEY)". Your admin chooses how Jira statuses map to ticket statuses. When an issue is Done in Jira, the person who owns the ticket gets a notification and a note.

Jira comments appear on the ticket as internal notes with the tag **Jira · name**. To send one of your own notes to Jira, click **Share with Jira** on the note. It then shows **Shared with Jira**. This button appears only when your admin allows sharing notes.

If your admin switched attachments on, each file on the ticket has **Send to Jira**. A file that came from Jira is marked **From Jira**.

## Many tickets at once

In the list view, tick up to 25 tickets. On the bar, click **Create Jira issues**, or **Link to Jira issue** to link all of them to one issue. You review the list before anything is sent.

## Tips

- Link the issue at the start, so engineers and support see the same story.
- Use **Sync now** if the status on the card looks old.
- Write a clear summary in the ticket. It becomes the Jira summary.

## Common mistakes

- Creating a second issue for the same problem. Use **Link existing issue** first.
- Expecting **Unlink** to close the Jira issue. It does not.
- Sharing internal notes that mention the customer's private details.

## Related pages

- [Work a ticket](/help/tickets/work-a-ticket)
- [Tickets overview](/help/tickets/tickets-overview)
