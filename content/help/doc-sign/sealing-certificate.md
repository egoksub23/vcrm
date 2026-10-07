---
title: The sealing certificate
description: What the certificate that seals your signed documents is, how to install one from a certificate authority, and what happens when it ends.
order: 21
updated: 2026-10-07
---

Every completed document is sealed with a digital certificate. The seal is how a PDF reader can tell whether the file was changed after it was signed. This page is about the certificate that makes the seal, and how to use one from a certificate authority.

## Before you start

Open **Settings**, then **Secure Sign**, then **Sealing certificate**. Seeing the certificate is for anyone who can manage Secure Sign settings, and so is installing or removing one.

## Two kinds of certificate

| | Made by Halo (self-signed) | From a certificate authority |
|---|---|---|
| Who makes it | Halo, for your workspace, the first time a document is sealed | A certificate authority that checks your organisation and gives you a file |
| Cost and effort | Nothing | You buy it and install it once |
| What a PDF reader shows | A warning that the signer's identity could not be verified | Who the certificate was issued to and by which authority. Whether the reader marks it as trusted depends on the reader |
| Does the seal still detect changes? | Yes | Yes |

Either way, the seal shows whether the document was changed after it was signed. The difference is whether the reader can also vouch for who made the seal.

> [!NOTE]
> Whether a given reader marks a certificate from an authority as trusted depends on whether that reader trusts the authority. Some readers only trust authorities on their own approved list. Before you buy, ask the authority which readers its certificate works in.

## What to ask a certificate authority for

Ask for a **document signing certificate for an organisation** (sometimes called a seal or organisational signing certificate), with:

- an **RSA key of at least 2048 bits**,
- delivered as a **.p12 or .pfx file** that includes the private key, and
- the **intermediate certificates** of the authority in the file, if it has them.

If you want Adobe Acrobat to trust the signature without extra steps, ask whether the authority is on Adobe's approved list for document signing. Confirm this with the authority; do not assume it.

## Install a certificate

1. On the **Sealing certificate** tab, find **Install a certificate**.
2. Choose the **.p12 or .pfx** file.
3. Type the file's **passphrase**.
4. Optionally give it a name for your own use.
5. Click **Check and install**.

The file is checked before it is kept: the passphrase, that it has a private key of at least 2048 bits, that it is valid today, that it is allowed to sign, that the chain of authorities is complete and unbroken, and a test seal. If something is wrong, you get a message that says what, and nothing is installed. Documents sealed from now on use the new certificate. Documents already sealed are not changed.

The passphrase you type is used once to open the file. Halo keeps the certificate and its key encrypted under its own passphrase, and never shows the key.

## What the page shows

The certificate's **subject** (who it was issued to), **issued by**, **serial number**, **valid from** and **valid until**, **time left**, its **SHA-256 fingerprint**, the key size and how many certificates go into the seal. It also says in plain words what a PDF reader will show for this kind of certificate, and warns about anything questionable, for example a file that comes without the authority's own certificates.

## Before it ends

A certificate from an authority ends on a known date. Halo tells your administrators in the notifications **30, 14 and 7 days before** that date, and again on the day it has ended.

If it ends and nobody installs a new one, documents that everyone has signed **wait, unsealed**. Nothing is lost and nothing is sealed with a certificate you did not choose: as soon as you install a valid certificate, the waiting documents are sealed.

To renew, get a new file from the authority and install it the same way. The new one replaces the old one for documents sealed from then on.

## Go back to the certificate Halo makes

Click **Remove this certificate** and confirm. Its key is deleted from Halo. Documents already sealed are not changed. Later documents are sealed with a self-signed certificate that Halo makes for your workspace, unless you install another.

## Tips

- Install the new certificate a week or two before the old one ends, so there is time to fix a problem.
- Keep the original file and its passphrase somewhere safe. Halo does not show them again.
- Seal a test document and open it in the PDF reader your customers use.

## Common mistakes

- **Choosing a certificate for a website.** A certificate made for a web server is not a document signing certificate. The page warns you if the certificate does not say it may sign documents.
- **A file without the private key.** A .cer or .crt file holds only the public part. You need the .p12 or .pfx.
- **Leaving out the authority's certificates.** Readers may not be able to follow the chain. Ask the authority for the full chain.
- **Reading the self-signed warning as a failure.** It is a statement about who made the certificate, not about the document.

## Related pages

- [The audit trail and the sealed PDF](/help/doc-sign/audit-trail-and-sealed-pdf)
- [Settings and the WhatsApp template](/help/doc-sign/settings-and-whatsapp)
- [How long signed documents are kept](/help/doc-sign/retention)
