---
title: Set up Incidents
description: For administrators: roles, rules, timing, categories, steps, compliance packs and keeping records.
order: 6
updated: 2026-11-08
---

The **Setup** section of the Incidents sidebar is for administrators. Work through it in this order. The **Setup guide** ticks each step off as you go.

| Page | Purpose |
|---|---|
| **Setup guide** | Shows what is done, and sends yourself a test notice. |
| **Roles & contacts** | Who is in each role. |
| **Rules** | Who is told about what. |
| **Timing & deadlines** | How long to wait, and when steps are due. |
| **Categories** | The kinds of incident people can report. |
| **Report form** | The questions a coach sees. |
| **Our own steps** | Extra required steps your school adds. |
| **Compliance packs** | PDPA, ISO and school-policy steps (in Settings, Incidents). |
| **Keeping records** | How long records are kept; export and delete. |

## Setup guide

Five steps: choose a template, add roles and people, switch on rules, pick compliance packs, check the report form. **Send yourself a test notice** sends one clearly marked test email to you, so you can see what people will receive. Nothing is recorded on any incident.

## Roles and contacts

A role is a job. Rules tell roles, so when someone leaves you change the role's people, not the rules.

- **Built-in roles**: Principal, Head of Sport, School nurse, Data protection officer, Safeguarding lead and Facilities manager. You can rename any of them: click the name, type, then click away. Add your own with **New role**.
- **Worked out for each incident**: Reporter, Incident lead and Parent or guardian. These have no fixed people.
- For each role choose to tell **everyone in the role** or **the first person who is available**. You can set a backup and away dates.
- On the **People** tab add staff and outside contacts, each with one or more email addresses.

> [!IMPORTANT]
> Put at least one person in each role you plan to use. A role with nobody in it tells nobody. Halo shows a warning triangle so you notice.

## Rules

A rule reads as a sentence: **when** something happens, **only if** it matches, **then** tell a role.

- **When**: an incident is raised, nobody acknowledges it, a required step is overdue, an incident is still open, an incident is escalated, or an incident is closed.
- **Only if**: choose categories, what it involves and a minimum severity. Choose nothing to apply to every incident.
- **Then**: tell one or more roles, optionally ask them to acknowledge, and optionally mark the incident a higher level.

Click **Switch on the starter set** for ready-made rules: serious injuries, suspected concussion, nobody acknowledged, personal data, property damage, safeguarding, confirming to the reporter, and a required step being overdue. Use **Try it** to see who would be told for a pretend incident. It sends nothing.

**Who is told when an incident is escalated.** Add the workflow rules **Tell the Principal when an incident is escalated to Level 2** and **Tell the Principal and the incident lead when an incident reaches Top level** (or write your own rule with **When: an incident is escalated** and **Only if the incident reaches** Level 2 or Level 3), and choose the roles. From then on, **Escalate now**, a timed escalation and a rule that raises the level all tell the people in that role, and the notice appears in the incident's message log. If nobody could be told at submission (for example the role has nobody in it, or the person has no email address), the "nobody acknowledged" rule still counts from the time the incident was raised, so it escalates instead of waiting silently. Once you have one switched-on escalation rule, the older separate list of names is no longer told, so you manage escalation in one place, with your Roles. Without such a rule, Halo keeps the older behaviour (every Admin and Owner, or the names set in the database).

The same page has **Before an incident moves on**: what must be true before an incident can move to each status, such as a root cause written, every required step done, a lead assigned, or approval by a named person.

## Timing and deadlines

- **How long to wait for an acknowledgement** starts at 30 minutes. If nobody acknowledges within that time, the Principal is told and the incident is raised to Level 2.
- **Deadlines of the built-in required steps**: each starts at the value that ships with Halo. Set your own hours, remove a deadline, or turn a step off. Changes apply to incidents raised from then on.

> [!WARNING]
> The PDPA deadlines come from the law. Change them only after your data protection officer or legal adviser agrees.

How long an incident can sit at a level before it escalates is under **Settings, Incidents**, **Escalation timers**. Who is told when it escalates is set under **Rules**: there is no separate list of names any more. The first time this was updated, anyone on the old list was brought across as a role (Escalation level 2, Escalation level 3) with a rule telling it; a school with no old list got two rules telling the Principal (and, at the top, the incident lead). Check them under Setup, Rules.

## Categories

The built-in template is shared by every school, so it cannot be changed directly. Make your school's own copy first.

1. Open **Setup, Categories** and click **Make our own copy**. It starts identical, and incidents already raised keep the categories they have.
2. To add a category, type a name and click **Add**.
3. To rename one, edit its name and click away. Its code never changes, so rules and forms that use it keep working.
4. **Starts at** sets the severity a new incident of this kind begins with. **More** sets a description and what it usually involves.
5. **Hide** removes a category from the Raise Incident form without breaking anything else. **Show** brings it back.
6. **Delete** is only offered when nothing uses the category. If incidents, rules or the report form use it, you can only hide it.

> [!NOTE]
> The last visible category cannot be hidden or deleted, because nobody could then raise an incident.

## Report form

The three short screens a coach fills in on a phone. The built-in form works as it is. Change it only if your school needs different questions. The builder lets you add, move and change questions, set what each answer means, preview on a phone, and keep versions. A report keeps the version it was filed under.

## Our own steps

Click **Start our own pack**, then **Add a step**: a title such as "Phone the parents", what the incident must involve, who must do it, and within how many hours (or no deadline). The step is added to every new incident that matches.

## Compliance packs

Under **Settings, Incidents, Standards** you choose the template and switch packs on or off. Each adds required steps, with due times, to matching incidents.

| Pack | Adds, for example |
|---|---|
| **PDPA Malaysia** | Assess whether a personal data breach is notifiable (24 hours); notify the PDP Commissioner if it is (72 hours); inform the people affected. |
| **ISO/IEC 27035** | Steps for information security incidents. |
| **ISO 45001** | Injury handling: first aid, next of kin, root cause, corrective actions. |
| **School steps (starter)** | Inform the principal (2 hours); report to the education authority if your school's policy requires it (24 hours); follow your child-protection procedure (24 hours). |

> [!IMPORTANT]
> The school steps pack is Halo's own starting checklist. It is not based on a ministry or education-office policy, and the hours are suggestions. Replace the wording and hours with your school's own procedures under Timing & deadlines, and ask school leadership which incidents your school must report outside, and by when. Confirm the PDPA wording with your data protection officer too.

## Keeping records

- **How long to keep**: by default records are kept until you delete them. You can have closed incidents deleted automatically after a number of years.
- **Delete old records**: pick a date, click **Check how many**, **Download export**, then type the confirmation phrase and click **Delete permanently**. Open incidents are never removed.
- A log shows what was exported or deleted.

> [!WARNING]
> A deleted incident cannot be brought back. Always export first.

## Tips

- Use the Setup guide's test notice before you rely on the rules.
- Review your roles when staff change: a role with nobody in it is the most common reason a notice is missed.

## Common mistakes

- **Leaving a role empty.** Nobody is told.
- **Changing a PDPA deadline without advice.** It comes from the law.
- **Hiding the only category people use.** Add or show another first.

## Related pages

- [Incidents overview](/help/incidents/incidents-overview)
- [Manage, escalate and close an incident](/help/incidents/manage-escalate-and-close)
- [Reports from the coach portal](/help/incidents/coach-reports)
- [Roles and permissions](/help/getting-started/roles-and-permissions)
