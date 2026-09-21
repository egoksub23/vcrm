---
title: Work a ticket
description: Assign, comment, change the status, say how it was resolved, follow the SLA timers and watch a ticket.
order: 3
updated: 2026-09-22
---

This page shows what to do after you open a ticket: take it, talk about it with your team, move it forward and close it.

## Open a ticket

Click a card on the board or a row in the list. The ticket opens in a large window. To see it as a full page, click the three dots (**More actions**), then **Open as full page**. Click **Copy link** to share the ticket with a teammate.

![An open ticket with the summary and activity on the left and the status, SLA and details on the right.](/help/img/work-a-ticket-01-detail.png)

On the left you have the summary, the description, the attachments, linked tickets, any extra fields and the activity. On the right you have the status button and the **Details** card.

## Take a ticket and change its details

Everything on the right saves as soon as you change it.

1. Click **Assign to me** under **Assignee**, or open the Assignee menu and choose someone else.
2. Choose a **Team**, if teams are set up.
3. Set the **Priority** and the **Type**.
4. Add **Labels**. A ticket can have up to 10 labels.
5. Set a **Due date**. Click the cross next to it to clear it.
6. Click the status button at the top of the right column, which shows the current status. Under **Transition to**, choose the next status. If you choose **Resolved** or **Closed**, the app asks how the ticket was resolved. See the next part.

To change the summary or description, click it, type, and save. Click **Open conversation**, if you see it, to go to the chat the ticket came from. Click the customer's name to open their profile.

The person you assign the ticket to gets a notification, unless you assigned it to yourself.

## Resolve or close a ticket

When you move a ticket to **Resolved** or **Closed**, a small window asks **How was this resolved?**

1. Choose a **Resolution** from the list, for example **Fixed**, **Answered / information given**, **Duplicate**, **Cannot reproduce**, **Won't fix** or **Customer did not respond**. Your admin can change this list.
2. Type a **Note** if the next person should know something. It is optional and can be up to 2000 characters.
3. Click **Move to Resolved** (or **Move to Closed**).

The ticket only moves after you click that button. If you click **Cancel** or close the window, nothing changes and the ticket stays where it was. On the board, the card goes back to its column.

Once the ticket is Resolved or Closed, the **Details** card on the right shows the **Resolution** and your note. Click **Change resolution** to pick another one later. Every change is written in the **History** tab, for example "Ada resolved this ticket as Fixed".

- If you re-open the ticket, the old resolution is kept in the history, and the app asks again when you resolve it a second time. The earlier choice is already selected, so you only confirm it or change it.
- Changes that the system makes on its own do not ask anyone. When Jira marks the linked issue as Done, the ticket gets the matching resolution, or **Resolved in Jira** if there is no match. A ticket closed by an automation gets **Closed automatically**.
- If your admin turned the requirement off, the window does not appear. You can still set a resolution later with **Change resolution**.
- If you see "A resolution is needed to resolve or close a ticket", choose one and try again.

## Comments and @mentions

1. Under **Activity**, click **Add a comment…**.
2. Type your comment. Type `@` and a name to mention a teammate. Choose them from the short list, either by clicking, or with the keyboard: the <kbd>↑</kbd> and <kbd>↓</kbd> keys move the shaded row, and <kbd>Enter</kbd> or <kbd>Tab</kbd> picks it. The list shows **People** first and **Teams** below, with the number of members in each team. Once picked, the name gets a coloured box (blue for a person, purple for a team), so you can see the mention has been made. A name that is only half typed has no box.
3. Choose what the mention asks for. As soon as your comment mentions someone, two buttons appear: **Needs a response** (the default) and **FYI only**.
4. Click **Save**, or press <kbd>Ctrl</kbd>+<kbd>Enter</kbd> (<kbd>Cmd</kbd>+<kbd>Enter</kbd> on a Mac).

A mentioned teammate gets a notification. Comments are for your team. The app does not send them to the customer. You can **Edit** or **Delete** your own comments. Use the tabs **All**, **Comments** and **History** to filter the timeline, and switch between **Newest first** and **Oldest first**.

### Mention a whole team

Choose a team, for example **@Support Team**, to ask everyone in it at once. The app looks at the team's members at the moment you save and asks each of them, except you. The comment shows the team name as a purple chip. Everyone reached also starts watching the ticket, so they can follow it and act on it.

- If someone in the team cannot open Tickets, they are skipped and you see a note such as "2 members were skipped: no ticket access".
- People who join the team later are not added to a comment that is already written.
- If you name a person and also their team, that person is asked once.

### Needs a response, or FYI only

**Needs a response** means "please answer on this ticket". Each person you asked is waiting on the ticket until one of these happens:

- They write a comment on the ticket. That answers the request.
- They click **Mark as done** on the ticket, when a reply is not needed.
- The ticket is set to Resolved or Closed. All open requests on it are then closed.
- You delete your comment, or click **Cancel request**. The request is withdrawn.

**FYI only** just tells them. Nothing waits on them, and no bubble appears for them.

Each request is written in the **History** tab, for example "Ada asked Bo for a response". A request to a team is one line, not one line per member. If you asked a ticket that is already Resolved or Closed, no response is requested, because nothing would close it.

### When someone asks for your response

A round number on **Tickets** in the sidebar counts the tickets that are waiting on you. It shows **9+** when there are more than nine and disappears when you have none. It is there when you sign in, and it updates on its own.

- On the Tickets page, click **Mentioned me** to see exactly those tickets. On the board and in the list, each of them shows a **Waiting on you** chip. Point at the chip to see who asked and how long ago.
- When you open the ticket, a yellow bar at the top says who asked, for example "Bo Chen asked for your response (via @Support Team)". Click **Go to comment** to jump to it, or **Mark as done**.
- The notification in your bell takes you to the comment, and it is marked as read when the request is closed.

### When you are waiting on someone

The ticket shows **You are waiting on** with a line for each person still pending. Click **Nudge** to send them a reminder. You can nudge the same person once an hour. Click **Cancel request** to withdraw it. Under your comment, a small line says who it is still waiting on.

## The activity timeline

The **History** tab lists every change: who changed the status, the resolution, priority, type, assignee, team, due date, labels, summary, description, links and attachments, and when. You do not need to write these down. Look at the timeline before you ask "who changed this?".

## Link related tickets

Under **Linked tickets**, click **Add link**. Choose how they relate: blocks, is blocked by, relates to, duplicates or is duplicated by. Search by key or summary, and click the ticket to link it.

## Attachments

Drop files onto the ticket, paste a picture, or click **Add file**. A ticket can have up to 20 attachments. You can remove a file you added.

## SLA timers and business hours

An SLA is a promise, such as "answer within 2 hours". If your admin has set one up for tickets like yours, an **SLA** box appears on the right with two lines.

- **First response** is met when a teammate writes the first comment on the ticket. A reply in the linked chat does not count for this.
- **Resolution** is met when the ticket is set to Resolved or Closed in time.

Each line shows a badge:

| Badge | Meaning |
|---|---|
| **On track** | Time is left. It shows how much, for example "Due in 2h 10m". |
| **At risk** | Not much time left. |
| **Breached** | The time is over. It shows how long ago. |
| **Paused** | The clock is stopped, for example while the ticket is Pending. |
| **Met** | Done in time. |

The clock runs while a ticket is Open or In progress. It usually pauses while the ticket is Pending, and it stops when the ticket is Resolved or Closed. If a ticket that met its resolution time is reopened, the resolution timer starts again. If your admin set business hours, the countdown counts only working time, such as Monday to Friday, 9 to 6. Due times are shown in your own time zone. Point at the badge or the policy name to see the details and the time zone of the schedule.

If no SLA rule matches a ticket, the box is hidden. That is normal. When a ticket is at risk or breached, the assignee gets one notification, and so do the watchers. If nobody is assigned, the admins get it.

## Watch a ticket

Click **Watch** to get notifications about a ticket, and **Unwatch** to stop. The person who raised the ticket and the person it is assigned to watch it automatically. Watchers are told when the status changes, when it is reassigned and when someone comments. You are never told about your own changes.

## Delete a ticket

Only people with permission see **Delete ticket** in the three-dot menu. By default that is admins. Deleting removes the comments, history and attachments too, and cannot be undone.

## Tips

- Add a comment when you change the status. Say why. For Resolved and Closed, write it in the resolution note.
- Use **@** to pull in the person who can help. Use **@** with a team when you do not know who is free.
- Pick **FYI only** when you do not need an answer, so your teammates' bubbles stay meaningful.
- Set the ticket to **Pending** when you wait for the customer, and back to **In progress** when they reply.

## Common mistakes

- Replying to the customer in a ticket comment. Reply in the chat. Ticket comments are internal.
- Mentioning a team with **Needs a response** for something that is only news. Every member then waits on it. Choose **FYI only**.
- Expecting a chat reply to stop the First response timer. Write a comment on the ticket.
- Leaving a ticket unassigned.
- Choosing **Fixed** when the customer simply did not answer. Pick the resolution that says what really happened, because the report counts them.

## Related pages

- [Create a ticket](/help/tickets/create-a-ticket)
- [Jira link](/help/tickets/jira-link)
- [Notifications](/help/working-together/notifications)
