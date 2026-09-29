// Form D — Status update / closure notice. P1 every 4h until contained
// then daily; P2 every 8h until contained then daily. Final notice sent
// once the resumption gate is passed and hypercare has ended.
import { Document, Packer, Paragraph, SectionType } from "docx";

import { incidentKey } from "../types";
import type { FormDComposeInput, IncidentDocumentContext } from "./types";
import { DOC_STYLES, bodyText, checkboxLine, docTitle, formatDateTimeMYT, referenceTable, sectionHeading } from "./shared";

function currentPositionStatus(i: IncidentDocumentContext["incident"]): "Ongoing" | "Contained" | "Recovered" | "Resumed" | "Closed" {
  if (i.status === "closed") return "Closed";
  if (i.status === "contained") return "Contained";
  if (i.status === "recovered" || i.status === "investigating") return i.resumed_at ? "Resumed" : "Recovered";
  return "Ongoing";
}

export async function buildFormDDocx(ctx: IncidentDocumentContext, compose: FormDComposeInput): Promise<Buffer> {
  const { incident: i } = ctx;
  const key = incidentKey(i);
  const isFinal = compose.updateType === "final_closure";
  const status = currentPositionStatus(i);

  const contact = [ctx.accountContact.name, ctx.accountContact.role, ctx.accountContact.mobile, ctx.accountContact.email]
    .filter(Boolean)
    .join(" · ");

  const doc = new Document({
    styles: DOC_STYLES,
    sections: [
      {
        properties: { type: SectionType.CONTINUOUS },
        children: [
          docTitle("Status update / closure notice", "D", "Regular updates while an incident is open, and the final closure notice"),
          new Paragraph({ text: "" }),

          sectionHeading("1 Reference"),
          referenceTable([
            ["Incident reference", key],
            ["Report date and time (MYT)", formatDateTimeMYT(new Date().toISOString())],
            ["Prepared by", `${compose.preparedByName}, ${compose.preparedByRole}`],
            ["Approved by", compose.approvedByName ? `${compose.approvedByName}, ${compose.approvedByRole ?? ""}` : "—"],
            ["Update no.", compose.updateNumber != null ? String(compose.updateNumber) : "—"],
          ]),
          checkboxLine([
            { label: "Status update", checked: !isFinal },
            { label: "Final: closure notice", checked: isFinal },
          ]),

          sectionHeading("2 Current position"),
          checkboxLine([
            { label: "Ongoing", checked: status === "Ongoing" },
            { label: "Contained", checked: status === "Contained" },
            { label: "Recovered", checked: status === "Recovered" },
            { label: "Resumed", checked: status === "Resumed" },
            { label: "Closed", checked: status === "Closed" },
          ]),
          bodyText(`Changes since last update: ${compose.changesSinceLastUpdate}`),

          sectionHeading("3 Actions"),
          referenceTable([
            ["Actions completed since last update", compose.completedSinceLastUpdate ?? ""],
            ["Actions in progress / next steps", compose.inProgressNextSteps ?? ""],
          ]),

          sectionHeading("4 Impact and requests"),
          referenceTable([
            [
              "Updated impact",
              [
                i.financial_impact_myr != null ? `RM ${i.financial_impact_myr}` : null,
                i.customers_affected_count != null ? `${i.customers_affected_count} customers` : null,
                i.merchants_affected_count != null ? `${i.merchants_affected_count} merchants` : null,
                i.data_records_affected_count != null ? `${i.data_records_affected_count} data records` : null,
              ]
                .filter(Boolean)
                .join(" · "),
            ],
            ["Requests to the recipient", compose.requestsToRecipient ?? ""],
          ]),

          ...(isFinal
            ? [
                sectionHeading("5 Closure (final notice only)"),
                referenceTable([
                  ["Service resumption date and time", formatDateTimeMYT(i.resumed_at)],
                  ["End of hypercare", formatDateTimeMYT(i.end_of_hypercare_at)],
                  ["Post-incident review report due", formatDateTimeMYT(i.pir_due_at)],
                ]),
              ]
            : []),

          sectionHeading("6 Next contact"),
          referenceTable([
            ["Next update due", compose.nextUpdateDue ? formatDateTimeMYT(compose.nextUpdateDue) : "—"],
            ["Vircle incident contact (24/7)", contact || "—"],
          ]),
        ],
      },
    ],
  });

  return Packer.toBuffer(doc);
}
