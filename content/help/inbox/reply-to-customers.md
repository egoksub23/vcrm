---
title: Reply to customers
description: Send text, emoji, snippets, files, photos, voice notes and WhatsApp templates, and fix a message that did not send.
order: 2
updated: 2026-09-21
---

Use the reply box at the bottom of an open chat to answer a customer. This page covers every way to send a message.

## Before you start

Your role needs to be allowed to send messages. If it is not, the reply box is greyed out and says "Read-only — viewers can browse but not reply". See [Roles and permissions](/help/getting-started/roles-and-permissions).

## Send a text reply

![The reply box with the Message, Comment, Snippets and Knowledge tabs above it, and the attach, template, AI and emoji buttons beside it](/help/img/reply-to-customers-01-composer.png)

1. Open the chat.
2. Make sure the **Message** tab is selected above the reply box. (The **Comment** tab is for private notes. See [Notes and mentions](/help/inbox/notes-and-mentions).)
3. If the customer has used more than one channel, pick the channel from the drop-down next to the tabs, for example **WhatsApp**. It starts on the channel of their latest message.
4. Type your message. Press <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line.
5. Press <kbd>Enter</kbd>, or the **Send** button (the paper plane).

Your message appears at once with a small clock. The clock changes as it moves on:

| Mark | Meaning |
|---|---|
| Clock | Sending |
| One grey tick | Sent |
| Two grey ticks | Delivered |
| Two blue ticks | Read |
| Red cross | Not sent. See "If a message did not send" below |

## Add an emoji

Press the smiley button (**Add emoji**) and pick one. Or type <kbd>:</kbd> and two letters, then press <kbd>Enter</kbd> or <kbd>Tab</kbd>.

## Quote an earlier message

Point at a message, then press the **Reply** arrow in the small toolbar. The quote shows above the reply box. Press **Cancel reply** to remove it. The same toolbar has **React**, **Copy text**, **Add to knowledge base** (only if your role can write knowledge) and **Move to trash**. Messages you move to the trash can be restored from the bin button (**Pending Delete**) above the conversation list.

## Use a snippet

A snippet is a saved reply.

1. Press the **Snippets** tab. A list slides up.
2. Press the snippet you want. Its text goes into the reply box below what you already typed.
3. Change it if you need to, then send.

Some snippets are interactive (buttons or a list). Those open a builder so you can check them before sending. The list only shows snippets that are approved. Snippets are added in **Settings**, under **Quick replies**.

## Send a photo, video, document or voice note

1. Press the paperclip (**Attach media**).
2. Choose **Photo**, **Video**, **Document** or **Voice note**.
3. For a photo, video or document, pick the file. A preview appears with **Add a caption…**.
4. Press **Send**. Press the cross first if you change your mind.

Size limits are 5 MB for photos and 16 MB for videos and documents. Photos can be PNG, JPEG or WebP. Videos can be MP4 or 3GPP. Documents can be PDF, Word, Excel, PowerPoint or plain text. Captions can be up to 1,024 characters. If a photo will not send, try saving it as JPEG or PNG.

You can also paste or drag a picture into the reply box. It appears as a **Pasted image** chip above the box and is sent as its own image after your text.

### Voice notes

Your browser asks for permission to use the microphone the first time. While you record, a bar shows the time (up to 5 minutes), a level meter and a microphone list. If it says "No sound detected", pick a different microphone. Press **Stop and attach**, listen if you like, then press **Send**. **Cancel** throws the recording away.

## Reply to an email

In the **Emails** tab the reply box is an editor with bold, italic, underline, strikethrough, lists and links. <kbd>Enter</kbd> starts a new line there, so press the **Send** button. The customer's earlier message is added below your reply automatically. Older emails in the thread are folded to one line. Click one to open it, and use **View plain text** or **View formatted** to switch views.

## The 24-hour window and WhatsApp templates

WhatsApp lets you send free text only within 24 hours of the customer's last message. The timer badge in the chat header counts this down. When it says **Expired**, the reply box says "Session expired - use a template" and is locked.

To start the conversation again on WhatsApp:

1. Press **Templates** in the amber bar above the reply box, or the template button next to the reply box.
2. Pick an approved template.
3. Fill in every placeholder. The preview updates as you type.
4. Press **Send template**.

The timer always counts from the customer's last message, on every channel. If an email or a web chat shows **Expired** and you cannot reply, tell your admin.

If the list says "No approved templates", ask your admin. Templates are approved by Meta, and admins sync them into Vircle CRM.

> [!NOTE]
> Templates can only be sent on WhatsApp. The interactive message button (buttons and lists) is also WhatsApp only.

## If a message did not send

When WhatsApp, Messenger, Instagram or your email connection refuses a message, it does not disappear. It stays in the chat with a red outline and a red **Not sent** panel under it. A pop-up also tells you what happened. The panel says why in plain words and what to do. Press the small **i** button for the provider's own message and error code. The same panel appears if Meta accepts a message and then fails to deliver it a moment later.

The panel has two buttons:

- **Resend** sends the same message again, on the same channel. Text, files, templates and buttons or lists are all resent. When it works, the red message is replaced by the new one, so the customer does not get it twice. If it fails again, the red message stays and shows the new reason. Press it once: a second click while it is sending does nothing.
- **Delete** moves the red message to the trash, like **Move to trash** in the message toolbar. You can restore it from the **Pending Delete** bin.

You need the same permission as for sending a message. Without it, both buttons are greyed out.

Common reasons:

- **The 24-hour window has closed.** Send a template. **Resend** does not try again on WhatsApp in this case. It tells you and opens the template list.
- **This number is not on your WhatsApp test number's allowed list.** Add the number in Meta, or use a production number.
- **The connection has expired.** Ask your admin to reconnect the channel in **Settings**, then **Channels**.
- **Sending too fast.** Wait a moment, then press **Resend**.
- **"WhatsApp not configured".** The channel is not connected. Ask your admin. No red message is kept for this one, because nothing was sent.
- **"Contact has no phone number or WhatsApp user ID"**, **"Invalid phone number format"** or **"Contact has no email address".** Fix the contact's details in the right-hand column, then send again. No red message is kept for these either.
- **A file is too big.** The message shows the size and the limit.
- **"Caption exceeds the 1024-character limit".** Shorten the caption.

A reason Vircle CRM does not know shows Meta's own words and the error code. Give both to your admin. If a template fails with "Template row is malformed locally", tell your admin.

A red message you never see a **Resend** button on (for example after your internet dropped while sending) can only be deleted. Type it again.

## Tips

- Press the sparkle button to have AI draft a reply. You always review it before sending. See [AI assistance](/help/inbox/ai-assistance).
- Type `/kb` and a word to insert a saved answer. See [Use articles in chat](/help/knowledge/use-articles-in-chat).

## Common mistakes

- **Typing in the Comment tab by accident.** Comments are amber and never reach the customer.
- **Moving a message to trash and expecting it to disappear for the customer.** It only hides the message inside Vircle CRM. It stays on the customer's phone.
- **Sending before a pasted picture has finished uploading.** A pasted image that still says "Uploading..." cannot be sent yet. Wait for it to finish.

## Next steps

- [Assign and hand over](/help/inbox/assign-and-transfer)
- [Notes and mentions](/help/inbox/notes-and-mentions)
