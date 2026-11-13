# Incident templates and compliance frameworks

Migration `206_incident_templates.sql`. Before it, one "standard" drove the whole incident module and an account could use only one at a time.

## The model

| Piece | What it is | How many per account |
|---|---|---|
| **Template** (`incident_standards.kind = 'template'`) | The categories people choose from and the one severity scale. BNM RMiT (Vircle) and School Incident Management ship today. | Exactly one active |
| **Framework** (`kind = 'framework'`) | A pack of obligation rules: PDPA Malaysia, ISO/IEC 27035, ISO 45001, School policy (starter). | Any number active |
| **Flag** (`incidents.incident_flags`) | What an incident involves: `injury`, `child_involved`, `personal_data`, `infosec`, `property_damage`, `security_breach`, `safeguarding`, `outside_agency`. A category starts with default flags; the reporter (and later the incident team) can change them. | Many per incident |
| **Obligation** (`incident_obligations`) | One checklist item on an incident, created when an active framework has a rule whose `trigger_flag` is on the incident. It has a due time (detected time + the rule's hours). | Many per incident |

Why a severity scale belongs to the template and not the framework: an incident has one severity. PDPA, ISO and BNM each have their own scale and cannot be combined on one record. Frameworks add what must be done and by when, not a second scale.

## What a school sees

1. Settings > Incidents > Standards: choose **School Incident Management** as the template and switch on the frameworks that apply.
2. Raise an incident: pick a category (CCA / sports injury, mishap / near miss, property damage, security breach, cyber, data breach, safeguarding ...). Its flags are pre-ticked; the dialog lists the obligations that will be tracked and when each is due.
3. On the incident: the **Involves** chips (editable by the incident team) and an **Obligations** panel with due / overdue times. Ticking an item needs `incidents.manage`.

Changing flags on an open incident adds the obligations that now apply, marks open ones that no longer apply as not applicable, and never touches ones already done. Switching a framework on affects incidents raised from then on, not existing ones.

## Other changes in 206

- Dropped the CHECK constraints that limited `incidents.incident_type` to the 14 BNM codes and `severity` to P1-P4 (and the P1-P4 CHECK on escalation policies). Before this, activating ISO 27035 or PDPA made raising an incident fail. A trigger now checks the type and severity against the incident's own template.
- `critical / high / medium / low` use the P1-P4 escalation timers by default.
- Forms A-D (BNM notification documents) show only for incidents raised under BNM RMiT.
- ISO 27035 and PDPA (migration 197) became frameworks; their old category rows are left in place but unused.

## Starter values to confirm

The framework rules are defaults, not legal advice. Have the school's data protection officer / leadership confirm before relying on them:

- PDPA: assess within 24 h, notify the PDP Commissioner within 72 h, notify data subjects (timing 240 h from detection = 72 h + 7 days). Check the current notification threshold (migration 197's description says 500 data subjects) against the PDPC guideline.
- School steps (starter): every rule is marked "Starter rule". These are Halo's own suggestions, not taken from any ministry or education-office policy (none is cited anywhere in the product). Which incidents the school must report outside, by when, and the child-protection reporting duties are for the school to set. Migration 221 renamed the pack "School steps (starter)" and removed the ministry wording.

## Adding a template or framework

SQL only for now (a Settings editor is the planned next phase): insert an `incident_standards` row with `kind`, then its `incident_type_catalogue` + `incident_severity_levels` (template) or `incident_obligation_rules` (framework). See the seeds at the end of 206. Use only the flags in `INCIDENT_FLAGS` (`src/lib/incidents/constants.ts`).

## Tests

- `src/lib/incidents/migration-206.test.ts` pins the SQL (the migration is not executed in CI).
- `src/app/api/incidents/incident-templates-routes.test.ts` covers raising under each template and switching templates / frameworks.
- Render and translation checks are in `incidents-render.test.tsx` and `i18n.test.ts`.
