---
title: The audit trail and the sealed PDF
description: What is recorded about each document, how the signed copy is sealed, and how to read the history.
order: 9
updated: 2026-10-06
---

Doc Sign keeps two kinds of proof for every document: a **history** of what happened, and a **sealed PDF** that shows if the document was changed after it was signed.

## The history (audit trail)

Open a document and click the **History** tab. Every step is listed with the time and who did it: created, sent, invited, opened, code sent or checked, agreed to sign electronically, signed, declined, reminded, cancelled, expired, sealed, downloaded. You can switch between newest first and oldest first. Saved progress is hidden unless you ask for it.

Each entry can show details such as the person's network address and device, the consent wording version, and a fingerprint of the file.

Entries cannot be edited or deleted. Each one is chained to the one before it, so an entry that was changed or removed would break the chain. The History tab shows a check at the top:

| Shown | Meaning |
|---|---|
| **Intact** | Every entry is chained to the one before and the chain checks out |
| **Does not check out** | An entry does not match the chain. Tell an admin |
| **Not checked** | The check could not be run just now. Try again later |

## The sealed PDF

When the last person signs, the server builds the final file. It places every answer and signature on the pages, adds certificate pages, applies a cryptographic seal and stores the result. Your browser and the signers' browsers are not trusted for the final file.

The certificate pages list the document's reference and title, a fingerprint of the file as it was sent, when it was sent and completed, every signer with their name, email, role and how they were invited, when each one signed, their network address and device, and the history of the document with a fingerprint of the audit trail.

Everyone on the document gets the signed copy by email. You can also download it from the document's page: use **Download signed PDF**, or **View** to open it. The **Files** list shows the signed copy and the certificate.

## What the seal tells you

If anyone changes the PDF after sealing, a PDF reader can tell. A seal made with an organisation's own certificate from a certificate authority shows as valid. A seal made with the certificate Doc Sign made for your workspace is **self-signed**, and PDF readers show a warning that the signer is not trusted. The seal still shows whether the file changed, but the reader cannot check who made the certificate. This is normal for a self-signed certificate. You can see which one your workspace uses under **Settings**, **Doc Sign**, **Sealing certificate**.

## Where the files are kept

The original, the signed copy and the certificate are kept in private storage. Only the server writes to it. You and the signers get short-lived links to download.

## Tips

- Keep the signed PDF as your record. It carries its own proof.
- If someone asks how you know a document was not changed, show them the certificate pages and the History tab.

## Common mistakes

- **Reading the self-signed warning as a failure.** It is a statement about who made the certificate, not about the document.
- **Looking for a signed copy while the status is Finishing.** It appears when the status is Completed.

## Related pages

- [What the signer sees](/help/doc-sign/what-the-signer-sees)
- [Remind, resend and cancel](/help/doc-sign/remind-resend-and-cancel)
- [Settings and the WhatsApp template](/help/doc-sign/settings-and-whatsapp)
