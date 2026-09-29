// Form A — Initial incident notification. Sent to BNM/sponsor EMI/
// affected partners. P1 within 2h (target 1h), P2 within 8h, P3 within
// 48h where notifiable. See the actual template read via pandoc for
// the exact section layout this mirrors.
import { Document, Packer, Paragraph, SectionType } from "docx";

import { INCIDENT_DETECTION_SOURCES, INCIDENT_SEVERITIES, INCIDENT_TYPES, incidentTypeLabel } from "../constants";
import { incidentKey } from "../types";
import type { FormAComposeInput, IncidentDocumentContext } from "./types";
import { DOC_STYLES, bodyText, checkboxLine, docTitle, formatDateTimeMYT, referenceTable, sectionHeading } from "./shared";

const RECIPIENT_LABELS: Record<string, string> = {
  bnm: "BNM (direct / via sponsor EMI)",
  sponsor_emi: "Sponsor EMI",
  safeguarding_bank: "Safeguarding bank",
  settlement_bank_acquirer: "Settlement bank / acquirer",
  payment_network: "Payment network",
  other: "Other",
};

const OTHER_PARTY_LABELS: Record<string, string> = {
  sponsor_emi: "Sponsor EMI",
  pdp_commissioner: "PDP Commissioner",
  nsrc: "PDRM / NSRC",
  mycert: "MyCERT",
  none_yet: "None yet",
};

function statusFromIncidentStatus(status: string): "Suspected" | "Confirmed" | "Contained" | "Ongoing" {
  if (status === "reported") return "Suspected";
  if (status === "triaged") return "Confirmed";
  if (status === "contained") return "Contained";
  return "Ongoing";
}

export async function buildFormADocx(ctx: IncidentDocumentContext, compose: FormAComposeInput): Promise<Buffer> {
  const { incident: i } = ctx;
  const key = incidentKey(i);
  const status = statusFromIncidentStatus(i.status);

  const contact = [ctx.accountContact.name, ctx.accountContact.role, ctx.accountContact.mobile, ctx.accountContact.email]
    .filter(Boolean)
    .join(" · ");

  const doc = new Document({
    styles: DOC_STYLES,
    sections: [
      {
        properties: { type: SectionType.CONTINUOUS },
        children: [
          docTitle("Initial incident notification", "A", "For BNM (directly or via the sponsor e-money issuer) and affected partners"),
          new Paragraph({ text: "" }),

          sectionHeading("1 Reference"),
          referenceTable([
            ["Incident reference", key],
            ["Report date and time (MYT)", formatDateTimeMYT(new Date().toISOString())],
            ["Prepared by", `${compose.preparedByName}, ${compose.preparedByRole}`],
            ["Approved by", compose.approvedByName ? `${compose.approvedByName}, ${compose.approvedByRole ?? ""}` : "—"],
            ["Vircle incident contact (24/7)", contact || "—"],
          ]),
          checkboxLine(
            Object.entries(RECIPIENT_LABELS).map(([value, label]) => ({ label, checked: compose.recipients.includes(value as never) })),
          ),

          sectionHeading("2 Classification"),
          checkboxLine(INCIDENT_SEVERITIES.map((s) => ({ label: s, checked: i.severity === s }))),
          checkboxLine(
            (INCIDENT_TYPES.map((t) => ({ label: t.code as string, checked: i.incident_type === t.code })) as { label: string; checked: boolean }[]).concat(
              // DF was added to the taxonomy after this form's checkbox grid was
              // printed — show it as an extra line item when it's the actual type.
              i.incident_type === "DF" ? [{ label: "DF (added after this form's print run)", checked: true }] : [],
            ),
          ),
          bodyText(`Type: ${incidentTypeLabel(i.incident_type)}`),
          checkboxLine((["Suspected", "Confirmed", "Contained", "Ongoing"] as const).map((s) => ({ label: s, checked: s === status }))),

          sectionHeading("3 Detection"),
          referenceTable([
            ["Detection time (T0)", formatDateTimeMYT(i.detected_at)],
            ["Incident start time (if known)", formatDateTimeMYT(i.incident_start_time)],
          ]),
          checkboxLine(
            INCIDENT_DETECTION_SOURCES.map((d) => ({ label: d.label, checked: d.value === i.detection_source })),
          ),

          sectionHeading("4 Description and scope"),
          bodyText(i.description),
          referenceTable([
            ["Affected systems / services", i.affected_systems ?? ""],
            ["Affected identifiers", Object.keys(i.affected_identifiers ?? {}).length ? JSON.stringify(i.affected_identifiers) : ""],
            [
              "Estimated impact",
              [
                i.financial_impact_myr != null ? `RM ${i.financial_impact_myr}` : null,
                i.customers_affected_count != null ? `${i.customers_affected_count} customers` : null,
                i.merchants_affected_count != null ? `${i.merchants_affected_count} merchants` : null,
                i.data_records_affected_count != null ? `${i.data_records_affected_count} data records` : null,
              ]
                .filter(Boolean)
                .join(" · "),
            ],
          ]),
          checkboxLine(
            (["yes", "no", "unknown"] as const).map((v) => ({
              label: v[0].toUpperCase() + v.slice(1),
              checked: i.recipient_directly_affected === v,
            })),
          ),

          sectionHeading("5 Actions"),
          referenceTable([["Containment actions taken so far", i.containment_summary ?? ""]]),
          referenceTable([["Actions requested of the recipient", compose.actionsRequested ?? ""]]),
          checkboxLine(
            Object.entries(OTHER_PARTY_LABELS).map(([value, label]) => ({
              label,
              checked: compose.otherPartiesNotified.includes(value as never),
            })),
          ),
          referenceTable([["Next update due", compose.nextUpdateDue ? formatDateTimeMYT(compose.nextUpdateDue) : "—"]]),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}
