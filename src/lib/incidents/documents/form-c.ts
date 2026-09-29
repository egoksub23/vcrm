// Form C — Post-incident review report. Root cause, lessons learned,
// corrective actions. Review meeting within 5 business days of closure,
// report issued within 10 business days (matches incidents.pir_due_at).
//
// §4a "Timeliness against targets" is the one section that can't fully
// auto-fill — see the plan's own discussion. Required/Actual come
// pre-filled where the record has them (fetch-context.ts), the rest is
// filled in by the compose step.
import { Document, Packer, Paragraph, SectionType } from "docx";

import { INCIDENT_SEVERITIES, incidentTypeLabel } from "../constants";
import { incidentKey } from "../types";
import type { FormCComposeInput, IncidentDocumentContext } from "./types";
import { CONTENT_WIDTH_DXA, DOC_STYLES, bodyText, checkboxLine, dataTable, docTitle, formatDateMYT, formatDateTimeMYT, referenceTable, sectionHeading } from "./shared";

const FACTOR_LABELS: Record<string, string> = { people: "People", process: "Process", technology: "Technology", third_party: "Third party" };
const METHOD_LABELS: Record<string, string> = { "5_whys": "5 Whys", fishbone: "Fishbone diagram", other: "Other" };

function durationBetween(startIso: string, endIso: string | null): string {
  if (!endIso) return "—";
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.round((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m`;
}

export async function buildFormCDocx(ctx: IncidentDocumentContext, compose: FormCComposeInput): Promise<Buffer> {
  const { incident: i } = ctx;
  const key = incidentKey(i);

  const doc = new Document({
    styles: DOC_STYLES,
    sections: [
      {
        properties: { type: SectionType.CONTINUOUS },
        children: [
          docTitle("Post-incident review report", "C", "Root cause, lessons learned and corrective actions"),
          new Paragraph({ text: "" }),

          sectionHeading("1 Reference"),
          referenceTable([
            ["Incident reference", key],
            ["Report date and time (MYT)", formatDateTimeMYT(new Date().toISOString())],
            ["Prepared by", `${compose.preparedByName}, ${compose.preparedByRole}`],
            ["Incident closure date", formatDateMYT(i.closed_at)],
            ["Review meeting date and attendees", i.pir_review_meeting_at ? `${formatDateMYT(i.pir_review_meeting_at)} — ${compose.reviewMeetingAttendees ?? i.pir_review_attendees ?? ""}` : (compose.reviewMeetingAttendees ?? "—")],
          ]),

          sectionHeading("2 Incident recap"),
          bodyText(i.description),
          checkboxLine(INCIDENT_SEVERITIES.map((s) => ({ label: s, checked: i.severity === s }))),
          bodyText(`Type: ${incidentTypeLabel(i.incident_type)}`),

          sectionHeading("2a Key times"),
          dataTable(
            ["Detected (T0)", "Contained", "Restored", "Closed", "Total duration"],
            [
              [
                formatDateTimeMYT(i.detected_at),
                formatDateTimeMYT(i.contained_at),
                formatDateTimeMYT(i.recovered_at),
                formatDateTimeMYT(i.closed_at),
                durationBetween(i.detected_at, i.closed_at),
              ],
            ],
            [1800, 1800, 1800, 1800, 1826],
          ),

          sectionHeading("3 Root cause analysis"),
          referenceTable([["Root cause", i.root_cause ?? ""]]),
          checkboxLine((i.contributing_factors.length > 0 ? i.contributing_factors : []).map((f) => ({ label: FACTOR_LABELS[f] ?? f, checked: true }))),
          bodyText(i.contributing_factors_detail),
          i.pir_method ? checkboxLine([{ label: METHOD_LABELS[i.pir_method] ?? i.pir_method, checked: true }]) : bodyText(null),

          sectionHeading("4 Response evaluation"),
          referenceTable([
            ["What worked well", i.what_worked_well ?? ""],
            ["What did not work well", i.what_did_not_work_well ?? ""],
          ]),

          sectionHeading("4a Timeliness against targets"),
          dataTable(
            ["Target", "Required", "Actual", "Met?", "Reason if missed"],
            compose.timelinessRows.map((r) => [r.label, r.required ?? "—", r.actual ?? "—", r.met === undefined ? "—" : r.met ? "Yes" : "No", r.reasonIfMissed ?? "—"]),
            [2200, 1700, 1900, 900, CONTENT_WIDTH_DXA - 2200 - 1700 - 1900 - 900],
          ),

          sectionHeading("5 Final impact"),
          referenceTable([
            [
              "Final financial, customer, merchant and data impact",
              [
                i.financial_impact_myr != null ? `RM ${i.financial_impact_myr}` : null,
                i.customers_affected_count != null ? `${i.customers_affected_count} customers` : null,
                i.merchants_affected_count != null ? `${i.merchants_affected_count} merchants` : null,
                i.data_records_affected_count != null ? `${i.data_records_affected_count} data records` : null,
              ]
                .filter(Boolean)
                .join(" · "),
            ],
            ["Funds recovered", i.funds_recovered_myr != null ? `RM ${i.funds_recovered_myr} — returned ${formatDateMYT(i.funds_recovered_at)}` : ""],
          ]),

          sectionHeading("6 Corrective and preventive actions"),
          dataTable(
            ["#", "Action", "Owner", "Due date", "Status"],
            ctx.actions.map((a, idx) => [String(idx + 1), a.description, ctx.incidentLeadName ?? "—", a.due_date ? formatDateMYT(a.due_date) : "—", a.status === "done" ? "Done" : "Open"]),
            [500, 4026, 1800, 1400, 1300],
          ),

          sectionHeading("Sign-off"),
          dataTable(
            ["Sign-off", "Name", "Date"],
            [
              ["Incident Lead (ISO)", compose.signOffIncidentLeadName ?? ctx.incidentLeadName ?? "—", "—"],
              ["Chief Executive Officer", compose.signOffCeoName ?? "—", "—"],
            ],
            [2500, 4026, 2500],
          ),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}
