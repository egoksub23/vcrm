---
title: Someone who can sign instead
description: Name a second person for the same role. Both are invited, whoever completes it first signs, and the other is told it was already done.
order: 23
updated: 2026-10-17
---

Sometimes one signature is enough but you do not know which of two people will get to it first: two finance contacts, or two directors of whom one is enough. On the **People** step you can name a second person for a person who must sign. Both are invited at the same time with a link each. **Whoever completes it first fills in the places and signs.** The other person is told it was already completed, gets no reminders, and the document does not wait for them.

This is not two signatures. If both people must sign, add both as separate people with their own signature blocks. See [Prepare the fields](/help/doc-sign/prepare-fields).

## Add someone who can sign instead

1. On the **People** step, find the person who must sign.
2. Click **Add someone who can sign instead** under their name.
3. Type the other person's name and email address. It must be a different person with a different address.
4. Place the signature blocks as usual. The blocks belong to the role, so either person fills in the same places.

Click **Remove** in the box to take them off again. Your work is saved as you go.

The second person always gets their link by email. It is not offered for a person who receives a copy, for a Halo user (see [Countersign in Halo](/help/doc-sign/countersign-in-halo)), or in a [document collection](/help/doc-sign/document-collections).

## What each person sees

While both are open, each person's page says that the other was also asked, with their name, and that whoever completes it first does it for both.

When one of them completes it, the other person's link opens a friendly page: **Already completed**. It is not a decline and it is not an error. It shows nothing of the document, and says there is nothing left for them to do.

If two people submit in the same second, the system accepts one and refuses the other. The person who was too late sees the same friendly page, and none of what they typed reaches the document.

## Signing order

The two people are in the same step. The step is done as soon as one of them has completed it, and the next step is invited then. The history says who finished: "Bala was invited because Siti finished". On the People list they count as one place, so a step with an alternate shows as **Step 1 (1 person)**. When you move one of them to another step, the other moves with them. See [Signing order](/help/doc-sign/signing-order).

## Reminders, expiry and cancelling

- **Before anyone has completed it**, a reminder goes to each of the two people who are still open, as for any other person.
- **After one has completed it**, the other person is never reminded, and is not written to when the document expires or is cancelled. They are not "waited for" on the document's page.
- **A decline by either person** stops the whole document, as a decline by anyone does.

## On the document's page, the history and the certificate

The people list shows the pair: the second person is marked **Can sign instead of Ali**, and the first **Siti can sign instead**. After it is completed, the person who did not need to sign is shown as **Not needed**, with the line **Did not need to sign: Siti completed it first**. The progress counts the role once.

The sealed PDF carries the signature, the name and the signing time of the person who actually completed it. The certificate lists the other person as **Alternate: did not need to sign**, and its history says "Ali was invited as an alternate and did not need to sign: Siti completed the role first". The same is in the document's history, in the language of the document.

Both people are on the document, so both get the signed copy by email when it is complete.

## Forms

For a form in parts, answers entered by either person land on the same role. If both have typed the same field, the later answer wins, as it does when a part is handed to a colleague. Once one person has completed the role, nothing the other person does can change the document.

If one person has handed a part of the form to a colleague (see [Forwarding and signing together](/help/doc-sign/forwarding-and-parallel-signing)) and the other person completes the role, that colleague is not needed any more either.

## Private documents and sensitive answers

Nothing changes. Who can see a private document, who may reveal a sensitive answer and the rule that a person only sees and answers their own role's places all work exactly as before. A sensitive answer stays masked to everyone who may not reveal it.

## Tips

- Use it when either person can do the job. If you want both to sign, use two people.
- Give the two people clearly different names, so the history reads well.
- The person you name second is a full person of the document: they can [forward their turn](/help/doc-sign/forwarding-and-parallel-signing) if forwarding is on, and you can change their address with **Change recipient**.

## Common mistakes

- **Expecting both signatures.** Only the first to complete the role signs. Add two people if both must sign.
- **Using the same address for both.** The second person must be someone else, with another address.
- **Trying to name an alternate from the API.** The public API still refuses to send a document with two people on one role (`role_shared`). Name the second person on the People step.

## Related pages

- [Send a document for signature](/help/doc-sign/send-a-document)
- [Signing order](/help/doc-sign/signing-order)
- [Sealing and the certificate](/help/doc-sign/sealing-certificate)
- [Remind, resend and cancel](/help/doc-sign/remind-resend-and-cancel)
