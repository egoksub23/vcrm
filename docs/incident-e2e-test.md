# Incident reporting: end-to-end functional test

Halo alone, with the simulated portal (`scripts/incident-sim-portal.mjs`) and a **test key**. Nothing depends on the real coach portal.
Run it on UAT after migrations 208 to 213 are applied. The automated part (`src/lib/incidents/e2e/journey.test.ts`, run by `npx vitest run src/lib/incidents`)
proves the pieces fit together in memory; this sheet proves them on the real database, a real mailbox and real phones.

Tick each line. Anything that fails goes on the fix list (G.5).

## Set up (once)

- [ ] Incidents is switched on for the school (platform flag) and the person running the test is an Owner or Admin.
- [ ] Settings > Incidents: the **School Incident Management** template is active; PDPA and ISO 45001 compliance packs are on.
- [ ] `NEXT_PUBLIC_SITE_URL` is set on the server, and the school can send email (a connected mailbox, or the platform sender).
- [ ] `INCIDENT_ACK_SECRET` is set on the server (any long random string). Without it acknowledge links never verify.
- [ ] The cron calls `/api/incidents/escalation-cron` every minute.
- [ ] **Setup guide** shows steps 1 to 4 done. Roles & contacts: put a real test inbox in **Head of Sport**, **School nurse**, **Principal** and **Data protection officer**. Add yourself as **Safeguarding lead** backup.
- [ ] **Rules**: switch on the starter set. Use **Try it** with a serious injury: it lists the Head of Sport and the nurse straight away and the Principal after 30 minutes.
- [ ] **Operator console > Coach portal** (the Halo administrator): create a **test key**; map the test school's Vircle Group (ID, name, school) with the test page's address as an allowed address. Setup > Coach portal & API shows the school its link.
- [ ] **Send yourself a test notice** (Setup guide): the email arrives, is marked TEST, shows no names.

## G.1 The whole journey

1. [ ] Run the simulated portal: `node scripts/incident-sim-portal.mjs --base https://<halo> --key ik_test_... --group <Vircle Group ID> --submit --origin https://<test page>`. Every line is PASS.
2. [ ] Open the printed report link on a phone. Three short screens; the roster shows the two made-up students; a typed visitor can be added.
3. [ ] Tick **Test Student A**, choose **Injury**, type a sentence, choose **Could not continue**, answer **Yes** to the head question, send. The confirmation shows a reference and who was told.
4. [ ] The incident appears on the Dashboard, marked as a test, with the right category, severity (Serious or Critical) and flags (injury, child involved, concussion).
5. [ ] The admins' inboxes (test report: admins only) have the notice: reference, category, severity, links. **No** child's name, no description.
6. [ ] The incident's **Message log** lists each message with its status.
7. [ ] Do **not** acknowledge for 31 minutes. Check: the Principal is told, the incident moves to **Level 2**, one new row in the message log.
8. [ ] Click **I have seen this** in the email (no sign-in needed). The row turns **Acknowledged**. No further reminders arrive.
9. [ ] As the nurse (a user linked to the School nurse contact with the medical permission), open the incident: **Return to play** panel. Set a date a week away.
10. [ ] `GET /api/public/clearances?student_ids=SIM-1` (or the simulated portal): the date comes back. Student B has none.
11. [ ] The Dashboard's **Need action now** tile counts the incident (click it to filter to those) until it is dealt with; **My tasks** shows the nurse's steps; tick one off from My tasks.
12. [ ] Complete the required steps, move the incident to Closed. Export: Setup > Coach portal & API > Keeping records > Download export.

## G.2 Phones, iframe and web view

For each of: Android Chrome, iPhone Safari, an iframe test page on the registered address, an Android web view test app, an iOS web view test app.

- [ ] The report opens and is usable one-handed; tap targets are comfortable.
- [ ] In the iframe: it sizes itself (no second scrollbar), and **submitted** reaches the parent page. A page on an address that is **not** registered shows a blank frame.
- [ ] Photo: with the camera allowed, the camera opens. With the camera blocked, the file picker opens instead.
- [ ] Turn on airplane mode before **Send report**: the page says it is saved on the phone. Turn it off: the report sends by itself and the reference appears. Refresh while offline: the answers are still there.
- [ ] With storage blocked (private window, web view with storage off) the report still works.

## G.3 Failure cases

- [ ] Expired link (wait 2 hours, or set the session's `expires_at` in the past): the page says it expired and what to do; nothing is filed.
- [ ] Reused link: sending the same report twice files one incident and returns the same reference.
- [ ] Wrong key: launch answers 401. Revoked key: launch answers 401 and the links it issued stop working.
- [ ] A role with nobody in it (remove the nurse): the report still files; the other roles are told; Roles & contacts and Try it both warn.
- [ ] Email bounce (set a nurse address that bounces): the row shows **Failed** with the reason; **Retry** works once the address is fixed.
- [ ] Oversize or wrong-type photo (15 MB file, a .zip): refused with a plain message; the report itself is unaffected.
- [ ] More than five photos: refused.
- [ ] Launch with a broken payload (no activity): 400 with the field named, and the roster is not echoed.

## G.4 School isolation

Needs a second test school, mapped to its own Vircle Group.

- [ ] A call naming school B's Vircle Group cannot open or file against school A's link, and an unmapped or switched-off Group answers 404 `unknown_group`.
- [ ] School B's `GET clearances` for a student id that school A has a date for returns nothing.
- [ ] School B's admins cannot see school A's incidents, roles, rules, message log or Vircle Group link (try the URLs). No school sees the platform key.
- [ ] Notices from a school A report reach only school A's people.

## G.5 Sign-off

- [ ] Fix list worked through; a clean re-run of G.1 and G.3.
- [ ] Owner sign-off, date: ______  name: ______

After sign-off: Phase 2B (hand the key and the guide to the portal's developer, joint run with the real portal on a test key, then the live key).
