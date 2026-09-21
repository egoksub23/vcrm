---
title: Web chat conversations
description: How chats from the website or app chat bubble look to you, what the identity badges mean, how to handle a possible duplicate, and how enquiries arrive.
order: 9
updated: 2026-09-21
---

The web chat is the small chat bubble on your website or in your app. Chats from it appear in the **Chats** tab with the **Web Widget** channel. You reply the same way as on other channels. This page covers what is special about web chat.

## Find web chats

In the **Chats** tab, open the channel drop-down (it starts as **All chat channels**) and tick **Web Widget**.

## The identity badges

Under the customer's name in the chat header, you may see one of these badges. Point at a badge to read its explanation.

| Badge | What it means |
|---|---|
| **Verified in-app** (green) | Your own app signed this customer in, so their identity is proven. |
| **Unverified web claim** (amber) | The visitor typed this phone number or email. Nothing proves it belongs to them. |
| **Possible duplicate** (red) | This visitor also matches another contact. It was not merged automatically. |
| No badge | The visitor chose to chat without giving details. |

> [!IMPORTANT]
> Treat an **Unverified web claim** with care. Anyone can type someone else's phone number or email. Do not share private details such as account information, balances, or another person's data in that chat. If the customer needs private details, ask your admin how your team confirms who they are.

![The chat header of a web chat, with the customer's name and the identity badges under it](/help/img/web-chat-conversations-01-badges.png)

## A possible duplicate

When a visitor's details match two different contacts and the identity is not proven, Vircle CRM does not merge them. Instead, an amber bar appears under the chat header. It says **Possible duplicate**, then "may be the same person as" and the other contact's name, phone and email. The bar has two buttons: **Merge** and **Dismiss**.

1. Compare the two contacts. Do the phone number, email and name look like one person?
2. If you are sure they are the same person, press **Merge**.
3. Read the box **Merge these contacts?** It says the other contact's chats, notes, tags and deals move into this contact, and the other contact is deleted. **This cannot be undone.**
4. Press **Merge contacts**.

If they are different people, press **Dismiss**. The same pair is not suggested again.

You need permission to merge contacts. If not, the buttons are greyed out with "Read-only — your role can't merge contacts". See [Roles and permissions](/help/getting-started/roles-and-permissions).

When a customer is **Verified in-app** and matches two contacts, Vircle CRM merges them for you. You do not need to do anything.

## Photos, voice notes and files

Visitors can send text, emoji, photos, videos, voice notes and files. Files can be up to 16 MB and voice notes up to 5 minutes. You see them as normal bubbles. Click a photo or video to open it full size. You can send the same kinds of files back with the paperclip (**Attach media**). Templates and interactive buttons are for WhatsApp only. See [Reply to customers](/help/inbox/reply-to-customers).

## Ticks

Your messages show ticks just like on WhatsApp: one tick for sent, two for delivered, two blue for read. When you open a web chat, the visitor's messages are marked as read, and their widget shows that.

## If the visitor has left

A reply to a visitor who has left the page stays in the chat window only. It is not sent by email or WhatsApp. They see it, with an unread marker, the next time that same browser opens the chat.

If the customer has also used another channel, such as WhatsApp, the channel drop-down next to the reply box lets you reply there instead. Remember the 24-hour rule on WhatsApp.

## Enquiries

Visitors we do not know yet see a choice: **I'm already a Vircle user**, **I have an enquiry**, or **Just chat, skip this**.

If they send an enquiry, you see:

- A new contact, marked as a lead, with their name and phone number or email. (If they were already a contact, that contact is used.)
- The tags **Web enquiry** and **Enquiry:** followed by the type they chose, for example **Enquiry: parent**. The types are parent, school, merchant and other.
- A first message that starts with "[Web enquiry - Parent]" (or the type they chose) and then their own words.

Your admin's routing rules then apply, so the chat may already be assigned to someone.

If a visitor said they are already a user but no matching contact was found, the contact gets the tag **Claims existing user**. Treat that as unverified.

## Tips

- The chat window speaks English, Bahasa Melayu and Mandarin. Set the contact's **Language** field so AI drafts match the customer's language.
- Use the **Web enquiry** tag filter to find new leads.

## Common mistakes

- **Treating a typed phone number as proof.** Only **Verified in-app** is proof.
- **Merging two contacts because the names look alike.** A merge cannot be undone. Check phone and email first.
- **Assuming a visitor who left the page got your reply.** It waits in the chat window. Look for the blue ticks to see if it was read.

## Next steps

- [Merge duplicate contacts](/help/contacts/merge-duplicates)
- [Tags, labels and priority](/help/inbox/tags-labels-priority)
