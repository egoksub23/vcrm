---
title: Manage, escalate and close an incident
description: Triage, classify and escalate an incident, track corrective actions, log external notifications, and close it out.
order: 3
updated: 2026-09-28
---

This page is for whoever triages incidents in your workspace — usually a **Compliance Officer**, an Admin or the Owner. If you only raise incidents, see [Raise an incident](/help/incidents/raise-an-incident) instead.

## Classify and assign

Open an incident to see its full record. You can set:

- **Type**, **Severity** and **Status** — change any of these from the fields at the top of the incident.
- **Incident lead** — who is running the response. Unassigned by default.

Every change is recorded in the incident's **Timeline**, with who made it and when.

![An open incident with its classification fields, escalation level and Actions panel](/help/img/manage-escalate-and-close-01-detail.png)

## Escalation

Every incident has an **escalation level**, shown at the top of the record. If an incident is left unacknowledged (still **Reported**) past your workspace's timer for its severity, Vircle Halo escalates it automatically — bumping the level and notifying the next tier: the incident's watchers and lead first, then Admins, then the Owner. Escalation stops as soon as the incident moves out of **Reported**.

Click **Escalate now** at any time to escalate immediately, for example when you want a second pair of eyes without waiting for the clock. A manual escalation is recorded in the Timeline the same as an automatic one.

## Corrective actions

The **Actions** panel tracks the corrective and preventive actions that come out of a post-incident review (PIR):

1. Click **Add action**.
2. Describe **what needs to be done**, and optionally set an **owner** and a **due date**.
3. Click **Save**.
4. Click **Mark done** once it is finished — the button becomes **Mark open** if you need to reopen it.

## Log external notifications

If your Compliance Officer or CEO notifies Bank Negara Malaysia, your sponsor e-money issuer, a partner, the PDP Commissioner, affected data subjects, the police, or anyone else outside the company, click **Log a notification** on the incident to record it — who was notified, when, how, and a reference if there is one.

> [!IMPORTANT]
> Vircle Halo never sends this notification for you. Logging one only records that a person already sent it through the proper channel — it is your audit trail, not a delivery mechanism.

## Timeline

The **Timeline** is a running log of everything that happened to the incident: created, status/severity/type changes, the incident lead being set, escalations and closure — each with who did it and when.

## Close an incident

Once the response is finished, move the incident's status to **Closed** and record a **root cause**. Closing an incident does not delete anything from its Timeline, Actions or Notifications sent — the full record stays for audit.

## The Compliance Officer role

**Compliance Officer** is not a built-in role — it is a role your Owner or Admin sets up once for your workspace, using the custom roles feature under **Settings**, **Roles & permissions**. It is typically based on the Agent role with the ability to manage incidents added on top, so someone can triage, escalate and close incidents without being made a full CRM Admin. If you think you should be able to manage incidents but cannot, ask your Owner or Admin to check whether you have been added to this role.

## Tips

- Triage quickly, even if classification is incomplete — a status of Triaged with "impact figures pending" is more useful than leaving something sitting at Reported.
- Use Escalate now sparingly for genuine urgency; let the automatic timers do the routine work.
- Write the root cause for the reader six months from now, not just for yourself today.

## Common mistakes

- **Downgrading a severity without a reason.** Always leave a note — the record should explain itself later.
- **Assuming "Log a notification" sends the notification.** It only records one that a person already sent.
- **Closing an incident before its corrective actions are done.** Actions can stay open after closure if needed, but check the list first.

## Related pages

- [Incidents overview](/help/incidents/incidents-overview)
- [Raise an incident](/help/incidents/raise-an-incident)
- [Roles and permissions](/help/getting-started/roles-and-permissions)
