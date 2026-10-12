---
title: KYC review
description: Look up a friend ID, read the identity checks on file, open the stored ID image and reveal masked details. Read-only, and every look is recorded.
order: 1
updated: 2026-10-12
---

KYC review is where compliance looks at the identity checks the ID verification service holds for a person, including the stored image of their ID. It sits in the sidebar directly below **Incidents**.

> [!NOTE]
> KYC review is **read-only** for now. You can look, but you cannot approve or reject. The page says so at the top, and will say something else once decisions exist.

The people in these records can be children, so the screen is deliberately careful. Halo **does not store** any ID image or any of the details you see: it asks the verification service each time. What Halo keeps is a **log of who looked at what** (see [Every look is recorded](#every-look-is-recorded)).

## Who can use it

KYC review is switched on for a workspace by the platform operator; until then there is no menu item. Inside a workspace it has three permissions, set in **Settings**, **Roles & permissions**, under **KYC review**:

| Permission | What it lets you do |
|---|---|
| **KYC review** (menu) | Open the screen, look a friend ID up and read the validations, with sensitive details masked. |
| **View ID images** | Open the stored ID image of a validation. |
| **Reveal sensitive KYC details** | Show the masked ID number, date of birth, address and similar details in full, for two minutes. |

Owners and Admins have all three. Nobody else does until an admin grants them. The **Access log** tab is only for admins and owners.

## Look a friend ID up

1. Open **KYC review** in the sidebar.
2. Paste or type the **friend ID** and press **Enter** (or **Search**). Letters, numbers and the characters `. _ @ : + -` are allowed, up to 100 characters. The clear button (the cross) empties the box.
3. The validations on file appear on the left, **newest first**. Each row shows the type of ID (for example NRIC), a **status** with its word and an icon (green for passed, amber for pending, red for failed, grey for anything else), how long ago it was submitted (hover for the exact time in your own time zone), a short id and a score if there is one.
4. **No validations for this ID** means the service knows nothing under that id.

The last few ids you searched are listed under the box so you can repeat a search. They are remembered in your browser only, and only the ids, never any details. **Clear recent** removes them.

On a phone the list takes the whole screen; open a validation to see it, and use the back arrow to return.

## Read a validation

Click a row. On the right you see:

- **ID image**: the stored image, with zoom in and out, rotate, and fit-to-window or actual size. With the keyboard, click the image and use **+** and **-** to zoom, **0** to reset, **R** to rotate, **F** to switch between fit and actual size, and the arrow keys to scroll.
- **Details**: the status, when it was submitted, the score, the reason if the service gave one, then the person's details. The ID number is shown **partly hidden** (for example `15••••••34`), and the date of birth, address and similar details show **Hidden**.
- **Other fields**: everything else the service sent, as it sent it.
- **Technical details** (collapsed): the validation id and the status word exactly as sent.

### Reveal the hidden details

If you have **Reveal sensitive KYC details**, press **Reveal sensitive details** on the card. The full values appear for **two minutes** and then hide again by themselves. They also hide when you open another validation, search again, switch tab or leave the page. **Hide again** hides them at once. Each reveal is recorded.

### The ID image

The image is fetched from the verification service when you open the validation, and nothing is saved. It carries a **watermark** with your name, the time and "Halo" across the whole picture, there is no download button, and right-click and dragging are switched off. After **three minutes without touching it**, or as soon as you switch to another tab, the image is hidden behind **Click to show**. Showing it again fetches it again and is recorded again.

> [!NOTE]
> These measures make a leaked image traceable to a person and a time. They cannot stop a screenshot or a photo of the screen, so treat what you see as you would a paper copy of the ID.

## When something does not work

| You see | What it means |
|---|---|
| **KYC review is not set up** | The server has not been given the verification service's address and key. Ask an administrator. |
| **The verification service could not be reached** | It is down or slow. Try again in a moment. |
| **The verification service did not accept Halo's access** | The key Halo uses was rejected. Tell an administrator. |
| **Could not load the image** | Use **Retry**. If it keeps failing, tell an administrator which validation it was. |
| **The image address was not allowed** | The service pointed to a place Halo does not trust. An administrator must allow it on the server. |
| **The access could not be recorded, so nothing was shown** | The log could not be written. Nothing is shown unless the look can be recorded. Try again. |
| **Field names are provisional** (administrators only) | None of the response matched the field names the screen expects, so everything is in the generic list. Tell the engineers. |

A **UAT** badge and banner at the top mean you are looking at the test service, not real records.

## Every look is recorded

The footer says it: **Every view of this page is recorded.** Searching a friend ID, reloading a list, opening an image and revealing details each add a line to the **access log**: who, when, which friend ID and validation, what they did and how it ended (found, nothing found, not allowed or an error). The log never holds an ID image, an ID number or any other detail, and nobody can edit or delete a line.

Admins and owners open the **Access log** tab to read it. They can filter by person, friend ID, action and date, and **Export CSV** the filtered rows (at most 5,000). The log is not trimmed: it stays for as long as the workspace exists.
