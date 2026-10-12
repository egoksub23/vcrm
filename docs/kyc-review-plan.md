# KYC review: plan

Status: phase 1 (read-only) is being built. Phases 2 and 3 wait for answers from the doc-processor engineers.
Owner: Vircle compliance. Menu: **KYC review**, directly below Incidents. Route: `/kyc`.

## 1. What this is

A staff screen in Halo over the `doc-processor` back end (UAT `https://apis-uat.vircle.com/verify_doc`), which holds the ID images and validation records of children submitted from the Vircle mobile app. Compliance reviewers need to look a child up, see the validations on file, and view the ID image. Later they need to approve or reject.

The data is about children and is the most sensitive data Halo will touch. Every design choice below follows from that.

## 2. What the back end gives us today

Taken from the Postman collection (no example responses were included):

| Call | Auth | Used by Halo? |
|---|---|---|
| `GET /health` | none | yes, to tell "service down" from "key rejected" |
| `POST /check` | mobile user's Cognito Bearer token | **no**: it belongs to the mobile app |
| `GET /validations?friend_id=<id>&limit=50` | `x-api-key` | yes |
| `GET /validations/{id}/url` | `x-api-key` | yes (signed image URL) |

What is **not** in the collection: any approve, reject or resubmit call; any list that is not scoped to one `friend_id`; the status vocabulary; the response field names; pagination beyond `limit`; any webhook.

## 3. Phase 1: read-only (building now)

### Scope
- Search by `friend_id`; list the validations on file; open an ID image.
- Show every field the API returns: known ones as labelled rows, the rest in a generic key-value list. Field names are provisional until engineers send samples (one adapter module, `src/lib/kyc/adapter.ts`, holds all the guesses).
- A banner: "Read-only. Decisions are not available yet."
- An **Access log** tab for admins and owners.

### Security model
| Concern | Decision |
|---|---|
| API key | server only (`KYC_DOC_API_KEY`, `KYC_DOC_API_BASE_URL`), never in the browser, logs or errors |
| Who sees the menu | platform feature `kyc` (off for every workspace until the operator turns it on, for Vircle only) **and** capability `menu.kyc` |
| Who opens an image | `kyc.view` |
| Who sees full ID number, date of birth, address | `kyc.reveal`, masked on the **server** by default |
| Defaults | Owner and Admin; every other role only when an admin grants it |
| ID image storage | **never stored in Halo**. Fetched server-side per view, streamed with no-store headers, vendor URL never sent to the browser |
| Image fetch safety | https only, host allow-list, no private IPs, no redirects, 15 MB cap, image types only |
| Deterrence | diagonal watermark (viewer, time), no download button, no right-click, hidden after 3 minutes idle or when the tab is hidden. Honest limit: this deters, it cannot stop a screenshot |
| Audit | `kyc_access_log`: who, when, what (lookup, list, view image, reveal), friend id, validation id, outcome. No keys, no image bytes, no field values. Append-only, admin-readable |

### Screens
1. **Search**: friend ID box.
2. **List** (left): one row per validation, newest first: type chip, status chip (colour plus word), time, short id, score if any.
3. **Detail** (right): image viewer (zoom, rotate, fit), data card with masked fields and a Reveal button, collapsed technical details.
4. **Access log** tab (admins/owners): filter by person, friend id, action, date; CSV export (max 5,000 rows).
5. Phone: list, then detail with a back arrow.

### Not in phase 1
Approve, reject, request resubmission, notes, assignment, a review queue, notifications, links to a Halo contact.

## 4. Phase 2: decisions (needs engineers)

The reviewer's actions: **Approve**, **Reject** (reason required), **Request resubmission** (message to the parent), plus an internal note. Every decision is recorded in Halo's own log as well as in the back end.

### API wishlist for the doc-processor engineers
1. `POST /validations/{id}/decision` with `{ decision: approved|rejected|resubmit, reason, reviewer }`, returning the updated validation. `reviewer` is the Halo user's email so the back end records who decided.
2. A **status vocabulary**: the full list of values and which are terminal.
3. **Idempotency**: sending the same decision twice must not fail or double-apply.
4. **Concurrency**: what happens if two reviewers decide at once (`409`? last write wins?).
5. **Side effects**: does approval update the child's status in the Vircle app, notify the parent, unlock features? Does a rejection send a message, and in which language?
6. **Resubmission**: does it reopen the same validation or create a new one linked to it?
7. **Reasons**: a fixed list of rejection reasons (so reports are consistent) or free text?
8. **Four eyes**: is a second reviewer required for any decision? If so the back end should enforce it, not only Halo.

## 5. Phase 3: a real review workflow

Needs the engineers too.

1. **A queue**: `GET /validations?status=pending&limit=&cursor=` across all children, newest or oldest first, with a total count. Without it a reviewer must already know whose ID to look up.
2. **New-submission signal**: a webhook to Halo (signed, with a replay window) or, at minimum, a count endpoint Halo can poll, so the menu can show "12 waiting".
3. **Pagination**: cursor based, stable under new submissions.
4. **Child and parent**: how a `friend_id` relates to a parent or guardian, so a decision or a resubmission request can reach the right person, and so Halo can link a validation to a contact.
5. **SLA**: how long a submission should wait; Halo can show ageing and escalate, as it does for tickets.
6. **Assignment and notes**: claim a case, hand it over, internal notes (Halo-side; the back end need not know).
7. **Reports**: approved, rejected, resubmitted, time to decision, by reviewer.

## 6. Questions for compliance (not engineers)

1. Which roles may view? Which may reveal? Which may decide?
2. Is a second reviewer required (four eyes), always or only for rejections?
3. How long may a reviewer keep an image open? (Halo defaults to a 3-minute idle cover.)
4. How long must the access log be kept? (Halo does not trim it.)
5. Under the PDPA (Malaysia), are children's ID images processed under a documented lawful basis and retention rule for this review purpose? The screen itself stores no image, but the access log records who looked at which child.
6. Who may be told when a reviewer looks at a child's record, and is a monthly access report to compliance wanted?

## 7. Risks and how they are handled

| Risk | Handling |
|---|---|
| A reviewer screenshots an ID | watermark with the viewer's name and time makes it attributable; audit shows who opened it; cannot be prevented technically |
| Key leak | server-only, rotate in the environment file, never logged |
| Wrong guess at the response shape | one adapter, tolerant parsing, generic table fallback, unit tests; fixed in one place when samples arrive |
| Feature enabled for the wrong workspace | `kyc` is off by default; only the operator console turns it on |
| UAT vs production confusion | the screen shows a clear "UAT" banner when the base URL is the UAT host |
| Back end down | health check separates "service unreachable" from "key rejected"; clear message, retry |

## 8. Delivery

| Release | Contents | Needs |
|---|---|---|
| A | Phase 1 read-only + access log, migration for `kyc_access_log` and the feature flag default | KYC env vars on the server |
| B | Phase 2 decisions | decision endpoint, status list, side-effect answers |
| C | Phase 3 queue, badge, SLA, reports | list-all endpoint, new-submission signal, parent link |

## 9. What to send the engineers

Items in sections 4 and 5, plus: **one real JSON sample each** (values blanked) of `GET /validations` and `GET /validations/{id}/url`, the status list, and the UAT API key for the Halo server (the key is entered on the server only; never share it in chat or email).
