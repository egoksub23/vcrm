# KYC review

Phase 2, read and decide. A staff screen under **Incidents** (menu **KYC review**, route `/kyc`) over the ID verification back end ("doc-processor"), which holds ID images and validation records of **children**. This is the most sensitive data Halo touches, and every choice below follows from that. The plan, the phases and the questions for compliance are in `docs/kyc-review-plan.md`.

What a reviewer can do today: look a **friend ID** up, read the validations on file (newest first), open the stored **ID image**, and (with a separate permission) **reveal** the masked values for two minutes. With a fourth permission (`kyc.decide`) a reviewer can also **approve or reject** a check (section 2.1). Without it the screen says so.

What Halo stores: **nothing of the child's**. The image is fetched from the back end each time it is shown and streamed to the reviewer; it is not saved. The only thing Halo keeps is the **access log**: who looked at which friend ID, when, and what happened (section 6).

> The back end's Postman collection has no example responses, so every field name below is a **guess** (section 8). The screen says "Field names are provisional" when none of a response's fields matched. Nothing in this document or in the code has been checked against the real service (section 10).

## 1. Turn it on

Three things have to be true, in this order.

### 1.1 The server knows the back end (environment)

Set these in the server's environment file (`.env.local`; `docker-compose.yml` reads it through `env_file`, so a container restart picks them up). They are **server-only**: never `NEXT_PUBLIC_`, never logged, never returned by any route, never in an error message or an access log row.

| Variable | Value |
|---|---|
| `KYC_DOC_API_BASE_URL` | UAT: `https://apis-uat.vircle.com/verify_doc`. Production: `https://apis.vircle.com/verify_doc`. Must be `https`, with no user name, query or fragment. |
| `KYC_DOC_API_KEY` | The back end's `x-api-key` (`UAT_general-api-key` for UAT, `Prod_general-api-key` for production). Enter it on the server only; never paste it in chat or email. |
| `KYC_DOC_ALLOWED_IMAGE_HOSTS` | Optional. Comma separated hosts the **signed image address** may point to besides the back end's own domain, for production: `vircle-id-docs.s3.amazonaws.com`. A leading `*.` matches any subdomain. Needed when the back end signs links on a storage host (very likely). |

Until both of the first two are set, the screen shows **"not set up"**: administrators see which variable names are missing (names only), everyone else sees "Ask an administrator". Restart Halo after changing them.

**UAT versus production.** The screen compares the base URL with a few words (`uat`, `staging`, `sandbox`, `test`, `dev`, `qa` as a part of the host name). When it looks like a test environment the screen shows a **UAT** badge and a banner, so nobody mistakes test data for production. To move to production, change the two variables and restart; there is no other switch.

### 1.2 The operator turns the `kyc` feature on for a workspace

`kyc` is a platform feature flag, **off for every workspace** that exists and every workspace made from now on (migration 182 writes an explicit `false` for each, and the signup seed does the same). Beyond that, the code reads an **absent key, a missing platform row or an unreadable one as off** for this flag only (every other flag reads absent as on): see `DEFAULT_OFF_FEATURES` in `src/lib/platform/features.ts`. Only the operator can turn it on.

To turn it on for **one** workspace (the owner will do this for the Vircle workspace only): sign in as a platform operator, open **Platform**, open the workspace, **Edit**, switch **KYC review** on, **Save**. Switching it off removes the menu item and every `menu.kyc` / `kyc.*` permission from everyone in that workspace at once, so the page and all the routes answer 403.

### 1.3 Permissions

Defaults below; an admin changes them per role in **Settings > Roles & permissions** (group **KYC review**). All four are app-tier (server routes; there is no table a browser reads with them) and can be granted down to **Agent**, never to Viewer.

| Permission | What it allows | Default |
|---|---|---|
| `menu.kyc` | See the menu item, open the screen, look a friend ID up, read the **masked** validations. Required for all the others. | Owner, Admin |
| `kyc.view` | Open the stored ID image. | Owner, Admin |
| `kyc.reveal` | Reveal the masked values (ID number, date of birth, address ...) of one validation for two minutes. | Owner, Admin |
| `kyc.decide` | Approve or reject an ID check (migration 188). Separate on purpose: a person can read and look without being able to decide. | Owner, Admin |

Every other role, and every custom role built on one, has none of them until an admin grants it. The **Access log** tab is for **admins and owners only**, whatever permissions a custom role has.

## 2. What the screen does

- **Start page**: opens on the **latest ID checks of everybody**, newest first, 50 at a time (**Load older** for more). No friend ID is needed.
- **Search**: a friend ID (1 to 100 characters of `A-Z a-z 0-9 . _ @ : + -`). Enter searches; paste is fine; the clear button empties it. The last eight ids searched are remembered **per person in this browser** (ids only, never data), with a "Clear recent" link.
- **Three panes, and the page itself never scrolls** (the Inbox's shape, and its drag handle; each width is remembered per person in this browser): the **queue** on the left, the **ID image** in the middle, and **who it is plus the decision** on the right. Each pane scrolls on its own, the image fits the height of its pane, and Approve and Reject sit at the foot of the right pane, in sight without scrolling.
- **Filters** (section 2.2), above the queue.
- **Queue rows**: the **decision** leads the row — "Approved", "Rejected", or "Needs review" for one nobody has looked at — then the status the back end sent (an icon and its word, green / amber / red / grey by meaning; never colour alone), then the kind, the time (relative; the exact time in the browser's time zone in the tooltip), a short id and a score if there is one. Empty: "No validations for this ID".
- **The image** (middle): zoom, rotate, fit or actual size, keys `+ - 0 R F`, a loading skeleton, "Could not load the image" with Retry. **One check is on screen at a time**: the viewer is mounted once and lets go of the previous image in the same render the check changes in, so two children can never be shown at once.
- **Who it is** (right): the **child** and the **parent** the check names (name and nickname shown; ID number and wallet id partly hidden; e-mail and phone hidden; all revealed by Reveal, which is logged), then the check's own known fields. Everything else the back end sent — its loose keys, the validation id, the status as sent — is under a collapsed **Technical details**.
- **Previous / Next** in the image pane's header, with "3 of 13", move through the queue as it is filtered.
- **Phone width**: the queue takes the screen; opening a check shows the image, who it is and the decision in one column, with a back arrow.
- **Footer**: "Every view of this page is recorded."
- **Access log tab** (admins and owners): section 6.

### 2.1 Approve and reject (migration 188, `kyc.decide`)

Under the data card, a **Decision** box. A check that already carries a review (`review_status` APPROVED or REJECTED, with its note and time) shows that instead, to everybody who can open the screen, and offers no buttons.

- **Approve** sets the child's eKYC status to Verified. **Reject** sets it to Rejected and the verification service **e-mails the parent**. Both are the back end's own doing (`POST /validations/{id}/review`, body `{"decision": "approve" | "reject", "note": "..."}`, `x-api-key`); Halo stores nothing of the decision except the access-log rows.
- A **note** is required to reject, optional to approve, one clean line of at most 500 characters. Both buttons open a confirmation that says what will happen and that Halo cannot undo it. While the call is out everything is disabled.
- **Order on the server** (`decideValidation` in `src/lib/kyc/service.ts`): `kyc.decide` or a 403 (logged `forbidden`); the check is read again and one that already carries a review is a 409 `already_decided` and nothing is sent (a rejection e-mails a parent, so it is never sent twice); an **`attempt` row is written before the back end is called** and when it cannot be written nothing is sent (`audit_failed`); the one POST, 25 s deadline, **never retried**; then a result row (`ok`, `error` or `not_found`). If only the result row cannot be written the decision still shows as done (the attempt row exists).
- The answer holds only the status word, the time, the note as sent, `partial` (the back end said it could not save the decision in both of its stores) and `emailSent` (after a rejection: true, false or unknown). The screen words each; nothing else the back end said is passed on.
- When the outcome is unclear (no answer, unreadable answer, 409) the screen reloads that check and tells the reviewer to look at its status before trying again.
- Twenty decisions a minute per person. Only a JSON body is accepted.

### 2.2 Filters, and why two of the three are the screen's own work

Three dropdowns over the queue:

| Filter | Options | Applied by |
| --- | --- | --- |
| **Review** | All checks, Needs review, Approved, Rejected | the screen |
| **Result** | any status word seen in the checks loaded (Unreadable, Match, Mismatch, No id on client ...) | the screen |
| **Document** | NRIC, Passport, Selfie | the **back end** (`doc_type`), so it fetches a fresh list |

The back end applies **only** `friend_id` and `doc_type`; it ignores every other filter it is sent (the engineers' collection of 19 Oct 2026). So "show me the approved ones" cannot be asked for: the screen reads pages itself (`before_id`) until it has **20 matches**, the back end runs out, or it has read **8 pages** in one go — whichever comes first. The cap matters: the list route allows thirty calls a minute per person and **every page is a row in the access log**. **Keep looking** reads the next eight. The count under the filters says both numbers ("7 matches, out of 400 looked at").

The document kind is also checked on the screen, so the filter still holds if the back end ever ignores the one it was sent. A check decided a moment ago **stays in the queue** even when "Needs review" would now drop it, so the reviewer can see what was recorded; it goes on the next search or filter change.

A real "waiting for review" list is still the right answer and is one of the open questions for the engineers (section 8).

## 3. Masking and Reveal

Masking is done **on the server**, in the adapter, before anything is put in an answer. The browser never receives a sensitive value it has not been allowed to show; a copy of the page source or the network tab holds only the masked text.

| Field | How it is masked |
|---|---|
| ID number (NRIC, passport, document number ...) | first 2 and last 2 characters with six dots between (`15••••••34`) when it has at least 10 characters; otherwise hidden. |
| Date of birth, address, phone, email, parent / guardian, gender, nationality ... | hidden ("Hidden" with a lock). |
| Any other field whose key matches the adapter's sensitive patterns (section 8) | by the rule above. |
| Links, storage paths, tokens, very long values (the back end's own image address, for example) | **not sent at all**; the technical details say how many were left out. |

A note for compliance: the first two digits of a Malaysian NRIC are the year of birth, so the partial mask shows that. If that is not acceptable, change `maskValue` in `src/lib/kyc/adapter.ts` to hide ID numbers fully.

**Reveal.** The data card has **Reveal sensitive details** (only for people with `kyc.reveal`; others see a note). It calls `GET /api/kyc/validations?friend_id=...&reveal=1&validation_id=...`, which the server honours only for a caller who holds `kyc.reveal`, for that **one** validation (every other row stays masked), at most ten a minute per person (counted in the database, so it holds across servers). The values are hidden again after **two minutes**, when the reviewer opens another validation, searches again, leaves the tab or the page goes to the background. Every reveal is written to the access log before the values are returned.

## 4. The ID image

`GET /api/kyc/validations/{id}/image` (needs `menu.kyc` and `kyc.view`):

1. asks the back end for a signed URL (`GET /validations/{id}/url`, with the key; the answer may be JSON, plain text or a redirect: the redirect's `Location` is read, not followed);
2. checks that URL (section 5) and fetches the image **on the server**, with a 10 second deadline and a **15 MB** cap, sending **no key** to the image host;
3. accepts only **JPEG, PNG or WebP**, checking both the declared type and the first bytes. **PDF is refused on purpose** (it can carry active content); if the back end stores PDFs, ask the engineers for page images;
4. writes the access log row; only then sends the bytes, with `Cache-Control: no-store, no-cache, private`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline`, `Referrer-Policy: no-referrer` and a sandboxing `Content-Security-Policy`. The back end's URL is never sent to the browser.

In the browser the bytes become a blob URL that is revoked when the viewer closes, the validation changes, the image is covered or the page is left.

**What the viewer does to deter copying, and what it cannot do.** A diagonal repeating watermark ("viewer name · time · Halo", a CSS background over the image, so it follows zoom and scroll); no download button; right-click and dragging the image are switched off; the image is hidden behind **Click to show** after **three minutes without interaction** and as soon as the tab is hidden (showing it again fetches it again, and is recorded again). **None of this can stop a screenshot or a photo of the screen.** It makes a leaked image traceable to a person and a time, and the access log shows who opened which validation.

## 5. Security model in one place

| Concern | What the code does |
|---|---|
| Key and base URL | Only in `src/lib/kyc/config.ts` (server). The routes return only which variable **names** are missing (to admins) and whether the base URL looks like UAT. Errors carry a code, never text from the network or the back end. A test searches every answer, every header and every log line for the key. |
| Feature flag | `kyc` off by default (section 1.2); a switched-off workspace has no `menu.kyc` or `kyc.*`, so every route answers 403. |
| Who | `requireCapability("menu.kyc")` on every route; `kyc.view` / `kyc.reveal` inside; `access-log` routes also need the admin role. A refused attempt is recorded as `forbidden`. |
| Signed image address | https only, no credentials, port 443, a plain DNS name (an IP address in any notation, `localhost`, `.local`, `.internal` ... are refused), and the host must be on the **back end's registrable domain** (not when that is a shared hosting domain such as `amazonaws.com`) or in `KYC_DOC_ALLOWED_IMAGE_HOSTS`. The connection itself goes through `pinnedFetch`, which refuses a private, loopback or link-local address whatever the name resolves to, and **no redirect is followed** anywhere. Rejected addresses are named (host only, never the query) in the server log so an admin can fix the allow-list. |
| Inputs | `friend_id` 1 to 100 characters of `[A-Za-z0-9._@:+-]`; `limit` clamped to 1..100 (default 50); the validation id must start with a letter or digit and use `[A-Za-z0-9._:@+-]` (so `..` can never walk the back end's path); anything else is a 400 and is neither sent upstream nor logged. |
| Limits | per person per minute: 30 lookups, 120 images, 10 reveals (shared, database-backed), 60 access-log reads, 6 CSV exports, 6 health checks. A 429 reaches neither the back end nor the log. |
| Timeouts and sizes | 10 s for every upstream call (covering the body as well as the headers); lists capped at 2 MB; images at 15 MB; a size or time overrun is an error, never a partial image. |
| Log first | If the access log row cannot be written, **nothing is returned** (503 `audit_failed`): the log is never skipped. |

Error codes the routes use (the screen words each in four languages; the back end's own words are never passed on): `not_configured` (503), `upstream_unreachable` (502: network, timeout, 5xx, 429), `upstream_unauthorized` (502: the key was rejected; admins are told to check `KYC_DOC_API_KEY`), `not_found` (404), `bad_response` (502), `image_too_large`, `image_type_unsupported`, `image_host_blocked` (502), `invalid_request` (400), `rate_limited` (429), `forbidden` (403), `audit_failed` (503). An unknown friend id is **not** an error: the back end's 404, or an empty list, shows "No validations for this ID".

Routes (all `GET` except the review, all `Cache-Control: no-store`):

| Route | Guards |
|---|---|
| `/api/kyc/status[?check=1]` | `menu.kyc`; `check=1` (back end `/health`, no key) admins only, 6 a minute |
| `/api/kyc/validations?friend_id=&doc_type=&limit=&reload=&reveal=1&validation_id=` | `menu.kyc`; `doc_type` is `nric`, `passport` or `selfie` (anything else is a 400 and is never sent upstream); `reveal=1` also `kyc.reveal` and the shared reveal limiter |
| `/api/kyc/validations/{id}/image?friend_id=` | `menu.kyc` and `kyc.view` |
| `POST /api/kyc/validations/{id}/review` body `{friend_id, decision, note}` | `menu.kyc` and `kyc.decide`; JSON only; 20 a minute; section 2.1 |
| `/api/kyc/access-log?user_id=&friend_id=&action=&from=&to=&before=&limit=` | `menu.kyc` and admin or owner |
| `/api/kyc/access-log/export?...` | the same, CSV, at most 5,000 rows |

## 6. Privacy and the access log

**Table `kyc_access_log`** (migration 182). Each row: workspace, person, **action** (`lookup`, `list`, `view_image`, `reveal`, `config_error`, `decision`), **friend ID** (as typed, trimmed, only if it passes the check above), **validation ID**, **outcome** (`ok`, `not_found`, `forbidden`, `error`, and `attempt` for the row a decision writes before the back end is called), the **decision** (`approve` or `reject`, only on a `decision` row) and the time. A row is written for every search (`lookup`), every reload of a list (`list`), every image shown (`view_image`), every reveal (`reveal`) and every set-up or rejected-key error (`config_error`); a refused attempt is a row with outcome `forbidden`; a search that finds nothing has outcome `not_found`.

**What is NOT stored**: the API key, the base URL, any image or image address, any field value (no name, no ID number, no date of birth), anything the back end answered, the search results. The writer builds the row from named arguments, so nothing else can reach it; tests check every audit row of every route.

- **Who can read it**: workspace admins and owners (row level security; the screen reads it through a server route). No browser role can insert, update or delete (privileges revoked, no policy), and the table is **append-only** in the database (a trigger refuses every `UPDATE`, `DELETE` and `TRUNCATE`, even from the service role), with the single exception the audit log has: a workspace being purged by `delete_workspace_data` (workspace deletion, PDPA erasure).
- **Retention**: **not trimmed** by any job. Rows stay until the workspace is deleted. There is no purge setting; if compliance wants one, decide the period first (`docs/kyc-review-plan.md`, question 4).
- **Export and deletion**: the table is part of the workspace export (the export discovers every table with an `account_id`; it excludes secrets only) and is removed with the workspace. The deleted login of a reviewer does not touch their rows (no foreign key on the person; the screen shows "Former member").
- **The Access log tab** (admins and owners) lists the latest rows with filters (person, friend ID, action, date from / to) and "Load more"; **Export CSV** applies the same filters and holds at most **5,000 rows** (the response header `X-Truncated` says when it was cut). Cells that start with `= + - @` are guarded against spreadsheet formulas.
- **A limit of what the friend ID in a `view_image` row proves**: the back end has no call that returns one validation by id, so the screen sends the friend ID it searched with, and the server records it if it is well formed. The back end gives Halo no way to check that the validation belongs to that friend, so treat that column as "what the reviewer was looking at" rather than proof. Anyone holding `kyc.view` can also open any validation id they can guess; the permission, not the id, is the protection.
- **Not recorded**: that an admin read or exported the log itself. Add an action to the enum in a later migration if compliance wants that.

The log records that a person looked at a child's record, which is itself personal data about the reviewer and the child: under the PDPA, decide who may see it and for how long (plan, section 6).

## 7. Setting it up and checking it

1. Set the two variables (UAT first), restart Halo.
2. Platform console: turn **KYC review** on for the workspace.
3. Sign in as an owner or admin of that workspace: **KYC review** appears directly below Incidents. As an admin, the **Check connection to the back end** link at the bottom asks `/health` (no key).
4. Search a friend ID that exists in UAT. If the list says "could not be read" or every field is under "Other fields" with the note "Field names are provisional", the response shape differs from the guesses: section 8.
5. Open a validation: the image, then **Reveal**; open the **Access log** tab and check the rows.

If a user says **"The verification service did not accept Halo's access"** the key is wrong or expired. **"The image address was not allowed"** means the signed address is on a host that is neither the back end's domain nor in `KYC_DOC_ALLOWED_IMAGE_HOSTS`: the server log has a line `[kyc] image_host_blocked (host_not_allowed:<host>)`.

## 8. For engineers: the adapter's field names

**Confirmed against production on 18 Oct 2026** (`GET https://apis.vircle.com/verify_doc/validations`, with and without `friend_id`; `GET /validations/{id}/url`): the list is `{"items": [...]}`, newest first by `id`; `limit` and `before_id` (the page before that id) work; `friend_id` is optional. A record is `id` (number), `friend_id` (a UUID), `doc_type` (`nric`, `passport`), `s3_key`, `job_status`, `capture_ok`, `capture_code` (`ok`, `blurry`, `too_dark`, `no_mrz`), `capture_message` (a sentence for the reviewer), `extracted_id`, `client_id_number`, `validation_status` (`NO_ID_ON_CLIENT`, `UNREADABLE` seen so far), `detail` (an object: `source`, `client_found`, `client_id_path`), `review_status`, `review_note`, `reviewed_at`, `created_at`. `/validations/{id}/url` answers `{"id","s3_key","url"}` where `url` is a signed link on `vircle-id-docs.s3.amazonaws.com`, so that host has to be in `KYC_DOC_ALLOWED_IMAGE_HOSTS`. `NO_ID_ON_CLIENT` is shown amber (the picture is readable, but Vircle holds no ID number to compare it with); `UNREADABLE` red. `extracted_id` and `client_id_number` are ID numbers and are masked. The tables below still list the other names the adapter would accept; the ones in this paragraph are the real ones.

The older text follows. All of the tables are in `src/lib/kyc/adapter.ts` (tests: `adapter.test.ts`). **Nothing else in Halo knows a vendor field name.** When a new status word or field appears, correct the tables, add the sample as a test fixture, and delete the "provisional" wording from the screen if you wish.


Keys are compared after lower-casing and dropping every character that is not a letter or digit (`created_at`, `createdAt` and `Created-At` are all `createdat`).

**The list** (`GET /validations?...`): an array; or an object holding an array under `validations`, `items`, `data`, `results`, `records`, `rows`, `documents` or `checks` (at the top or one level down); or a single record; or `{}` (nothing on file). Anything else (an error object, text) is `bad_response`. A 404 is an empty list.

| Meaning | Keys tried, in order |
|---|---|
| Record id (top level only) | `id`, `validationid`, `uuid`, `recordid`, `requestid`, `checkid` |
| Friend id | `friendid`, `userid`, `customerid`, `memberid` |
| Type | `type`, `documenttype`, `doctype`, `idtype`, `kind`, `validationtype` |
| Status | `status`, `validationstatus`, `verificationstatus`, `state`, `decision`, `result`, `outcome`, `verdict` |
| Created | `createdat`, `created`, `timestamp`, `submittedat`, `checkedat`, `createdon`, `date`, `time` (ISO text, epoch seconds or milliseconds) |
| Updated | `updatedat`, `modifiedat`, `updated`, `lastupdated`, `processedat`, `reviewedat` |
| Reason | `capturemessage`, `reason`, `message`, `failurereason`, `errormessage`, `error`, `detail`, `remarks`, `comment`, `note` |
| Score | `confidence`, `score`, `confidencescore`, `matchscore`, `similarity`, `probability` (0 to 1 is shown as a percentage) |
| Name | `name`, `fullname`, `holdername`, `cardholdername`, `namefromid`, `extractedname` |
| ID number (partial mask) | `nric`, `idnumber`, `icnumber`, `icno`, `icnum`, `idno`, `extractedid`, `documentnumber`, `documentno`, `passportnumber`, `passportno`, `identitynumber`, `mykad`, `mykid`, `nationalid` |
| ID on Vircle's record (partial mask) | `clientidnumber` |
| Date of birth (hidden) | `dateofbirth`, `dob`, `birthdate`, `birthday`, `dateofbirthiso` |
| Address (hidden) | `address`, `fulladdress`, `residentialaddress`, `addressline1`, `homeaddress` |

Nested objects are flattened to dotted paths (three levels, 20 array entries); a field is found by its last segment, shallowest first. Every other scalar is shown in "Other fields" with its path.

**Status words** (a negative word beats a pending one beats a positive one, so `not_verified` is red): positive `approved approve verified passed pass ok success successful valid accepted matched match true`; pending `pending review processing queued submitted waiting inprogress progress manual flagged new created uploaded started`; negative `rejected reject failed fail invalid mismatch declined denied error unverified unreadable blocked expired false no not cancelled canceled`. Anything else is grey and shows the raw word.

**Sensitive keys**: a key containing `nric icnum icno idnum idno identity passport mykad mykid nationalid nationalno documentnum documentno docnum docno ssn taxid license licence` is masked partially; one containing `dob birth address street postcode postalcode zipcode phone mobile msisdn email parent guardian mother father gender sex race religion nationality` is hidden.

**Never sent to the browser**: a key containing `url uri link href bucket s3 storage filepath path signature signed token secret password apikey accesskey secretkey credential authorization base64 imagedata blob objectkey imagekey filekey`, a value that starts with a scheme (`https://`, `s3://`, `data:` ...), a value over 600 characters, and a string value under an `image`, `photo`, `selfie`, `picture`, `scan`, `file` or `document` key that is long or contains `/`.

**The signed URL** (`GET /validations/{id}/url`): a redirect (its `Location`); a JSON object with the address under `url`, `signedurl`, `link`, `href`, `downloadurl`, `presignedurl`, `imageurl`, `documenturl` or `location` (top level, or in a nested object); a JSON string; or plain text that is the address. Anything else is `bad_response`.

To fix a guess: edit the table in `adapter.ts`, add the real sample to `adapter.test.ts`, run `npx vitest run src/lib/kyc`. The test `adapter.test.ts > the guesses are listed in one place` also checks that every key above appears in this document.

**The engineers' collection of 19 Oct 2026** (UAT base `https://apis-uat.vircle.com/verify_doc`; the review call is described there and was **not called on production by Halo's developers**, because it changes real children's records): the list now also carries `parent` and `child` objects (`id`, `name`, `nickname`, `identification`, `client_type`, `email`, `wallet_id`, `phone_number`) and accepts `doc_type=selfie|nric|passport`; the signed-URL answer adds `expires_in`; `POST /validations/{id}/review` answers `{id, friend_id, decision, review_status, ekyc_status, postgres: {ok}, dynamodb: {ok}, reviewed_at, note, email: {ok}}`. The adapter takes `parent` and `child` out of the record before it is flattened (so a parent's name is never the check's "Name") and reads them with their own masking rules (`PERSON_FIELDS`), and reads `review_status`, `review_note`, `reviewed_at` as the check's review. Production sends the two people **twice** — at the top level and again inside `detail` — so `stripPeople` takes them out wherever they sit, at any depth, the record's own winning over a copy nested deeper; without it the same seven values were listed a second time as raw key names (`detail.child.identification` ...) and filled the screen. Still unanswered by the engineers: whether a decision can be changed afterwards, whether `validation_status` changes, and a way to list only the checks still waiting for review (filters other than `friend_id` and `doc_type` are ignored).

## 9. Tests, and what they do not cover

- `src/lib/kyc/*.test.ts`: the adapter (arrays, objects, odd shapes, missing fields, masking, link withholding, URL extraction), the SSRF guard (private addresses in every notation, look-alike hosts, shared domains, schemes, ports), the configuration, the upstream client with an injected `fetch` (timeouts that hold even for a fetch that ignores the abort signal, size caps for declared and streamed bodies, wrong types, lying types, redirects).
- `src/app/api/kyc/kyc-routes.test.ts`: every route with an injected back end: not set up, rejected key, timeouts-as-failures, masking on the server, reveal permission and limiter, an audit row for every action and no key or value in any row, header, answer or log line, input validation, per-person rate limits, the log-first rule, the admin-only log and CSV.
- `src/lib/auth/*.test.ts`, `src/lib/platform/features.test.ts`: the three permissions (catalogue, defaults, parity with migration 182) and the default-off flag; `src/components/layout/nav-items.test.ts`: the menu row.
- `src/components/kyc/*.test.*`: the pure helpers (idle cover, reveal timer, watermark, zoom state and keys, recent searches) and the markup of every state in all four languages.
- `supabase/ci/verify-188-kyc-decisions.sql` (run it rolled back against production): `kyc.decide`, the log's new action, outcome and column, and that it is still append-only and closed to browsers; `src/lib/kyc/migration-188.test.ts` guards the text of the migration.
- `supabase/ci/verify-182-kyc-review.sql` (run it rolled back against production): the permissions, the flag, the log's privileges and append-only rule, the workspace export and deletion.

**Not covered by a test** (there is no DOM renderer in this repo): clicking, typing and focus movement, the 5 second idle check and the visibility listener that cover the image, the two-minute reveal timer, blob URL creation and revocation, the browser's real right-click and drag handling, the phone layout and dark mode appearance, and any call to the **real** back end. The list and `/url` shapes were checked against the **production** API on 18 Oct 2026 (section 8). Not yet seen: the status words other than `NO_ID_ON_CLIENT` and `UNREADABLE`, a record whose `extracted_id` or `client_id_number` is filled, and anything about approving or rejecting (the records carry `review_status`, `review_note` and `reviewed_at`, so the back end has somewhere to keep a decision, but Halo has no call for it).
