// Form B — Full incident report. Sent to every party that received Form
// A. P1 within 48h, P2 within 96h, P3 on request.
import { Document, Packer, Paragraph, SectionType } from "docx";

import { INCIDENT_SEVERITIES, INCIDENT_TYPES, incidentTypeLabel } from "../constants";
import { incidentKey } from "../types";
import type { FormBComposeInput, IncidentDocumentContext } from "./types";
import { CONTENT_WIDTH_DXA, DOC_STYLES, bodyText, checkboxLine, dataTable, docTitle, formatDateTimeMYT, referenceTable, sectionHeading } from "./shared";

const PARTY_LABELS: Record<string, string> = {
  bnm: "Bank Negara Malaysia",
  sponsor_emi: "Sponsor e-money issuer",
  partner: "Partner",
  pdp_commissioner: "PDP Commissioner",
  data_subjects: "Data subjects",
  police: "PDRM",
  other: "Other",
  safeguarding_bank: "Safeguarding bank",
  settlement_bank_acquirer: "Settlement bank / acquirer",
  payment_network: "Payment network",
  nsrc: "NSRC",
  mycert: "MyCERT",
};

export async function buildFormBDocx(ctx: IncidentDocumentContext, compose: FormBComposeInput): Promise<Buffer> {
  const { incident: i } = ctx;
  const key = incidentKey(i);

  const doc = new Document({
    styles: DOC_STYLES,
    sections: [
      {
        properties: { type: SectionType.CONTINUOUS },
        children: [
          docTitle("Full incident report", "B", "Detailed report to every party that received Form A"),
          new Paragraph({ text: "" }),

          sectionHeading("1 Reference"),
          referenceTable([
            ["Incident reference", key],
            ["Report date and time (MYT)", formatDateTimeMYT(new Date().toISOString())],
            ["Prepared by", `${compose.preparedByName}, ${compose.preparedByRole}`],
            ["Approved by", compose.approvedByName ? `${compose.approvedByName}, ${compose.approvedByRole ?? ""}` : "—"],
            ["Form A sent on", compose.formASentAt ? formatDateTimeMYT(compose.formASentAt) : (ctx.lastGenerated.a ? formatDateTimeMYT(ctx.lastGenerated.a) : "—")],
          ]),
          checkboxLine(INCIDENT_SEVERITIES.map((s) => ({ label: s, checked: i.severity === s }))),
          bodyText(`Type: ${incidentTypeLabel(i.incident_type)} (${INCIDENT_TYPES.find((t) => t.code === i.incident_type)?.code ?? i.incident_type})`),

          sectionHeading("2 Executive summary"),
          bodyText(compose.executiveSummary),

          sectionHeading("3 Detailed timeline (MYT) — from first indicator to time of report"),
          dataTable(
            ["Date and time", "Event or action", "By whom"],
            compose.timeline.map((row) => [formatDateTimeMYT(row.at), row.event, row.by]),
            [2400, 4626, 2000],
          ),

          sectionHeading("4 Detection and nature"),
          referenceTable([
            ["Method of detection", i.detection_source],
            ["Attack vector / cause (preliminary)", i.attack_vector ?? ""],
            ["Threat actor information (if known)", i.threat_actor_info ?? ""],
          ]),

          sectionHeading("5 Affected assets"),
          referenceTable([
            ["Systems and components", i.affected_systems ?? ""],
            ["Wallets, merchants and QR IDs", Object.keys(i.affected_identifiers ?? {}).length ? JSON.stringify(i.affected_identifiers) : ""],
            ["Data affected", i.data_records_affected_count != null ? `${i.data_records_affected_count} data records` : ""],
          ]),
          checkboxLine(
            (["yes", "no", "unknown"] as const).map((v) => ({
              label: v[0].toUpperCase() + v.slice(1),
              checked: i.children_data_involved === v,
            })),
          ),

          sectionHeading("6 Impact assessment"),
          referenceTable([
            ["Financial", i.financial_impact_myr != null ? `RM ${i.financial_impact_myr}` : ""],
            ["Operational", i.downtime_minutes != null ? `${i.downtime_minutes} minutes downtime` : ""],
            [
              "Customers and merchants",
              [
                i.customers_affected_count != null ? `${i.customers_affected_count} customers` : null,
                i.merchants_affected_count != null ? `${i.merchants_affected_count} merchants` : null,
              ]
                .filter(Boolean)
                .join(" · "),
            ],
            ["Reputational and regulatory", compose.reputationalRegulatoryImpact ?? ""],
          ]),

          sectionHeading("7 Response"),
          referenceTable([
            ["Containment actions", i.containment_summary ?? ""],
            ["Eradication actions", i.eradication_summary ?? ""],
            ["Recovery actions and current status", i.recovery_summary ?? ""],
            ["Vendor / provider involvement", i.vendor_involvement ?? ""],
          ]),

          sectionHeading("8 Notifications made"),
          dataTable(
            ["Party notified", "Date and time", "Method", "Reference no."],
            ctx.notificationsSent.map((n) => [
              PARTY_LABELS[n.recipient_party] ?? n.recipient_party,
              formatDateTimeMYT(n.sent_at),
              n.method ?? "—",
              n.reference ?? "—",
            ]),
            [2400, 2400, 2126, 2100],
          ),

          sectionHeading("9 Evidence attached"),
          dataTable(
            ["#", "File name", "Description", "SHA-256 hash"],
            ctx.attachments.map((a, idx) => [String(idx + 1), a.filename, a.evidenceDescription ?? "—", a.file_hash ?? "—"]),
            [500, 2500, 2526, 3500],
          ),

          sectionHeading("10 Next steps"),
          dataTable(
            ["Planned action", "Target date"],
            ctx.actions.filter((a) => a.status === "open").map((a) => [a.description, a.due_date ? formatDateTimeMYT(a.due_date) : "—"]),
            [CONTENT_WIDTH_DXA - 2500, 2500],
          ),
          referenceTable([["Contact person for follow-up", `${compose.nextStepsContact.name}, ${compose.nextStepsContact.role}`]]),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}
