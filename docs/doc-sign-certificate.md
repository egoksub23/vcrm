# Secure Sign: the sealing certificate (self-signed or from a certificate authority)

Every completed document is sealed with a digital signature (a PKCS#7 signature over the whole PDF, `adbe.pkcs7.detached`). The certificate that makes it is per workspace. This page is for whoever decides which certificate to use and installs it. It follows `docs/doc-sign-setup.md` section 6.

Applies from migration `165_sign_retention.sql`. Apply it before the code that reads `sign_certificates.source`.

## 1. The decision

| | Self-signed (Halo makes it) | From a certificate authority |
|---|---|---|
| Set-up | None. The first seal makes one for the workspace, valid 5 years, and keeps it encrypted | Buy it, install it once in Settings |
| Does the seal detect a change after signing? | Yes | Yes |
| What a PDF reader shows | A warning that the signer could not be verified | The subject and the authority. Trusted or not depends on whether that reader trusts the authority |
| When it ends | Renewed automatically at the next seal. Nobody is asked | **Never silently replaced.** Sealing stops with a reason until a valid certificate is installed |

You can start with the self-signed one and switch later. Documents sealed earlier are not touched by a switch (section 7).

## 2. What a PDF reader shows

These are the common cases, not a promise for every version of every reader: test the readers your customers use.

- **Self-signed.** Adobe Acrobat and Reader show the signature with a warning that the signer's identity is unknown because the certificate is not in the list of trusted identities, together with "the document has not been modified since the signature was applied". The warning is about who made the certificate, not about the document.
- **From a certificate authority that Adobe trusts.** The signer's name is shown, and the signature is marked valid without the user adding anything. Adobe trusts the authorities on its Approved Trust List (AATL) and the certificates in the operating system's trust store that the reader is set to use. Which of those a given authority is on is for the authority to confirm.
- **From an authority the reader does not trust.** The same warning as self-signed, but with the authority named. Users can add the authority's root to their trusted certificates.
- **Other readers** (browsers, phone and desktop previewers) differ: some show the signature, some do not check it at all.

Halo's seal carries the whole chain that is in the installed file (the signer's certificate and the authority certificates above it), so a reader can follow the chain without fetching anything.

## 3. What to buy, and what to ask the authority

In Malaysia, certification authorities that issue certificates under the Digital Signature Act 1997 are licensed by the Malaysian Communications and Multimedia Commission (MCMC), which publishes the list. Authorities that have been on it include MSC Trustgate, Digicert Sdn Bhd (formerly Pos Digicert) and Telekom Applied Business. Confirm the current list, and the products and prices, with MCMC and with each authority. This page does not vouch for any of them.

Ask for a **document signing certificate for an organisation** (a "seal", or an organisational signing certificate), and confirm in writing:

1. **An RSA key of at least 2048 bits.** Halo refuses smaller keys. Elliptic-curve keys are not supported.
2. **An exportable PKCS#12 file (`.p12` or `.pfx`).** This is the point most likely to go wrong. Many authorities, and the Adobe Approved Trust List rules for the certificates it trusts automatically, require the private key to live on a hardware token or in the authority's own signing service. Such a key **cannot be exported**, and Secure Sign cannot use it today. Ask: "Can I receive this certificate as a PKCS#12 file with the private key that I can load into software?" If the answer is no, that product does not fit, and the next choices are a different product or building support for signing through the authority's service (not built).
3. **The authority's intermediate certificate(s) in the file**, or sent separately so you can add them. Without them a reader may not be able to build the chain.
4. **Key usage that allows signing** (digital signature, and non-repudiation or content commitment, if it lists any), and, if it lists extended key usages, one meant for signing documents or email (document signing, email protection, or "any").
5. **A SHA-256 (or stronger) signature.** SHA-1 is accepted by Halo with a warning but readers are phasing it out; MD5 is refused.
6. **Whether the authority is on Adobe's Approved Trust List** for document signing, if you want Adobe Acrobat to trust the signature with no action by the reader. Confirm with the authority.
7. **The validity period and the renewal process.** Document signing certificates commonly last one to three years; confirm with the authority.
8. **Whether they offer a trusted timestamp service** (see section 8).

Ask your lawyer what legal weight a seal by the organisation has for your documents. The seal proves integrity and the organisation that sealed. It is not each signer's own certificate-based signature.

## 4. Install it

Settings > Secure Sign > **Sealing certificate** > Install a certificate. Choose the `.p12` or `.pfx`, type its passphrase, click **Check and install**. Needs `sign.settings`.

The server checks, in this order, and refuses with a message for each:

| Code | What is wrong | What to do |
|---|---|---|
| `p12_unreadable` | Not a PKCS#12 file, or empty | Choose the `.p12`/`.pfx`, not the `.cer` or `.pem` |
| `p12_bad_passphrase` | The passphrase does not open it | Check it; there are no retries beyond 10 a minute |
| `p12_no_key` | Certificates but no private key | Ask for the file that includes the key |
| `p12_unsupported_algorithm` | A key that is not RSA, an unreadable encryption, or a certificate signed with MD5 | Ask for RSA. If the chain holds an elliptic-curve certificate, export the file without it |
| `p12_key_mismatch` | The key belongs to none of the certificates in the file | Export again from where the certificate was made |
| `p12_key_too_small` | Under 2048 bits | New certificate |
| `p12_expired`, `p12_not_yet_valid` | Outside its dates today | Install a current one, or on/after its start date |
| `p12_key_usage` | The key usage extension forbids signing | Ask for a document signing certificate |
| `p12_chain_invalid` | A certificate is not signed by the one above it | Ask for the complete, correct chain |
| `certificate_chain_too_large` | The chain does not fit in the signature (about 8 KB) | Include only what the authority requires |
| `certificate_self_test_failed` | A test seal could not be made and verified | Check the file with the authority |
| `certificate_file_too_large` | Over 256 KB | It is not a certificate file |

Warnings that do not stop the install, shown on the screen: the file has none of the authority's certificates above the signer's; a certificate is signed with SHA-1; a certificate above is outside its dates; the certificate's extended key usage does not include signing documents or email. Each says what to ask the authority.

What is stored: a clean copy (the signer's certificate and the certificates above it, the key) under a passphrase Halo makes, encrypted with the key ring like every secret (`sign_certificates.p12_enc`, `passphrase_enc`; the Re-encrypt job covers them). The file's own passphrase is not stored. Nothing the screen reads includes the key.

## 5. Rotate it

Install the new file the same way, a week or two before the old one ends. The new certificate becomes the default and the one the workspace's settings point at; the old row stays on file, no longer the default. Documents sealed from then on use the new one. To go back to the self-signed certificate, **Remove this certificate**: its key is deleted, and the next seal makes a self-signed one unless another is installed.

## 6. Before it ends, and when it has

- A certificate the workspace uploaded is watched by the Secure Sign job (every minute, `runCertificateWatch`). The owner and admins (members who hold `sign.settings`) get a Halo notification at **30, 14 and 7 days** before it ends and once when it has **ended**, each once. The last warning sent is kept on the row (`sign_certificates.expiry_notified_days`).
- The self-signed certificate is not watched: it lasts five years and is renewed by the next seal.
- If an uploaded certificate has ended (or cannot be opened) when a document finishes signing, **sealing stops**. The document stays in "sealing" with a readable reason (it shows on the document's page to people who manage settings), keeps its attempts (`sign_hold_sealing`), is tried again every few minutes, and is sealed as soon as a valid certificate is installed. Nothing is sealed with a certificate nobody chose, and the signers are not asked to sign again.

## 7. Documents sealed earlier

Unchanged, whatever you do. The signature, the certificate inside it and the chain are part of the sealed file. Installing, rotating or removing a certificate never rewrites a sealed PDF.

## 8. What is not built, and what to know

- **No trusted timestamp, no long-term validation.** The seal records the signing time from Halo's clock, not from a timestamp authority, and carries no revocation data. Readers therefore judge a certificate by today's date: after the certificate ends, some readers show earlier seals with an expired-certificate notice even though the file is unchanged. The integrity check (not modified since sealing) stays true. A timestamp (RFC 3161) and long-term validation are a possible follow-up; ask the authority whether it sells a timestamp service.
- **Keys on a hardware token or in an authority's service** cannot be used (section 3, point 2).
- **A chain with an elliptic-curve certificate** in it cannot be read by the library Secure Sign uses. Export the file with RSA certificates only.
- **One certificate per workspace** is in use at a time. There is no per-person or per-category certificate.
- **Certificate expiry is told in Halo only** (notifications), not by email.

## 9. Trying the screen before you buy

You can make a test chain with OpenSSL and install it. Halo will show it as issued by "Test Issuing CA", which no reader trusts.

```
openssl req -x509 -newkey rsa:2048 -nodes -keyout root.key -out root.pem -days 3650 -subj "/C=MY/O=Test Trust/CN=Test Root CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
openssl req -newkey rsa:2048 -nodes -keyout inter.key -out inter.csr -subj "/C=MY/O=Test Trust/CN=Test Issuing CA"
printf "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n" > inter.ext
openssl x509 -req -in inter.csr -CA root.pem -CAkey root.key -CAcreateserial -out inter.pem -days 1825 -extfile inter.ext
openssl req -newkey rsa:2048 -nodes -keyout leaf.key -out leaf.csr -subj "/C=MY/O=Your Company/CN=Your Company Sdn Bhd"
printf "basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\nextendedKeyUsage=emailProtection\n" > leaf.ext
openssl x509 -req -in leaf.csr -CA inter.pem -CAkey inter.key -CAcreateserial -out leaf.pem -days 365 -extfile leaf.ext
cat inter.pem root.pem > chain.pem
openssl pkcs12 -export -inkey leaf.key -in leaf.pem -certfile chain.pem -name "Company seal" -out seal.p12
```

Install `seal.p12` from the screen. Remove it afterwards, and delete the files, which hold a private key.

## 10. Operator notes

- Migration `165_sign_retention.sql` adds `sign_certificates.source` (`generated` or `uploaded`; existing rows not named "Halo self-signed ..." become `uploaded`), `expiry_notified_days`, `sign_install_certificate()` (one transaction that swaps the default), `sign_hold_sealing()` and the notification type `sign_certificate_expiring`. `supabase/ci/verify-165-sign-retention.sql` proves them.
- `GET/POST/DELETE /api/sign/settings/certificate`, all `sign.settings`. The upload is limited to 10 tries a minute per person and 256 KB.
- Tests: `src/lib/sign/pdf/p12-upload.test.ts` (every rejection, chains, files made by OpenSSL, a chain verified by OpenSSL), `src/lib/sign/service/certificates.test.ts` (install, expired certificate, the whole sealing), `src/lib/sign/service/certificate-watch.test.ts` (30/14/7/0, once each).

## The certificate of completion is a file of its own (migration 178)

The digital signature above is made twice for every document sealed from migration 178 on, with the same workspace certificate and in the same step:

1. **The signed document**: the file that was sent with what the people entered written on it, and one small grey line in the bottom margin of EVERY page, centred, about 7 pt, 14 pt above the bottom edge: `Vircle Secure Sign · ID <document id>`, and for a document of a collection `Vircle Secure Sign · COL-… · ID <document id>`. The ID is the id in the address of the verify page and in the certificate's QR code. The line is written in the same pass as the answers, before the seal and the SHA-256 are made, so the seal covers it. It follows pages stored rotated, crop boxes that do not start at 0,0 and landscape pages, and is made smaller or left off a page too small to hold it. It never fails a seal: if stamping it makes the step fail, the step is repeated without the line (and the log says so); a failure for any other reason fails the seal as before. A draft, a preview and a document being signed never carry it. There are no certificate pages in this file.
2. **The certificate**: a PDF of its own, made after the signed file is sealed so that it can name it: the reference and the document id, the name and SHA-256 of the signed file it covers, who signed and when, the timeline, the audit-trail fingerprint, the QR code, and for a document of a collection the collection's reference and how many documents it holds (with each one's fingerprint as sent). It is sealed with the same certificate as the signed file, so a PDF reader shows its signature too.

Both files are stored in the document's own folder in the `sign-documents` bucket (`final/<sha256>.pdf` and `certificate/<sha256>.pdf`), read back and fingerprinted, and recorded in ONE database call (`sign_finish_sealing`, which also writes `sign_documents.certificate_path` and `certificate_sha256`). If anything fails on the way, including the certificate, nothing is recorded, what was stored is removed, the reason is kept on the document, and the sealing job tries again like for any other failure (up to five attempts, then `failed` and the sender's **Try again**). A document is never completed without its certificate.

**Settings > Secure Sign > General > Certificate of completion: "Also embed the certificate inside the signed PDF"** (`sign_settings.embed_certificate`, off until the workspace chooses). When on, a new document ALSO gets the certificate pages at the end of the signed PDF (the way every document was sealed before), as well as the separate file; the ID line is on those pages too.

**Documents sealed before the migration** keep their embedded certificate pages untouched (changing a sealed file would break its seal). They have a NULL `certificate_path`, and everything that reads it treats that as "the certificate is inside the signed PDF": one download button, no certificate or zip button, the API's `certificate` answers `no_separate_certificate`, the emails say what they always said, the zip holds the signed file only. The database refuses to give such a document a certificate later, and refuses to change or remove the certificate of one that has it.

**Downloads.** A document: "Signed document", "Certificate" and "Download all (zip)" on its detail screen, on the signer's finished page, and in the API (`GET /api/v1/sign/documents/{id}/certificate`, or `file?kind=certificate`). A collection: ONE "Download all (zip)" holding every signed document, its certificate and a small "Collection summary" PDF (reference, title, and for each document its fingerprint and signers; the summary is an index and is not sealed itself). The documents list's zip carries each document's certificate too. **Emails**: the signed document(s) and the certificate(s) are separate attachments within the transport's budget (2.5 MB Microsoft 365, 17 MB Gmail, 20 MB the platform sender); whatever does not fit goes as before (the message says to ask the sender / open the signing link, and names the public check page for a person who receives a copy; never a download link that would open the file to anyone).

**The verify page** (`/verify/<id>`) shows, for a document with a certificate of its own, the name of the signed file the certificate covers and the certificate's fingerprint, and "Check your copy" accepts either file (compared in the browser; nothing is uploaded). `sign_verify_chain` is unchanged: it recomputes the audit trail, which is the same for both layouts.

**Apply migration 178 BEFORE deploying the code that goes with it.** Code that is already running keeps sealing with embedded certificates (the function keeps working with three arguments). Prove it with `supabase/ci/verify-178-sign-standalone-certificate.sql`.
