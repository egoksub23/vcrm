import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import type { Incident } from "../types";
import { buildFormADocx } from "./form-a";
import { buildFormBDocx } from "./form-b";
import { buildFormCDocx } from "./form-c";
import { buildFormDDocx } from "./form-d";
import type { IncidentDocumentContext } from "./types";

const incident: Incident = {
  id: "inc-1",
  account_id: "acc-1",
  incident_number: 42,
  title: "Unusual outbound transfers after a device change",
  description: "Customer reported repeated device changes followed by outbound transfers.",
  incident_type: "AT",
  incident_type_secondary: [],
  severity: "P1",
  severity_downgrade_reason: null,
  status: "investigating",
  detected_at: "2026-09-20T01:00:00Z",
  detection_source: "customer",
  reporter_id: "u1",
  incident_lead_id: "u2",
  notifiable: true,
  notifiable_rationale: null,
  pdpa_relevant: false,
  aml_relevant: true,
  affected_systems: "Wallet transfers",
  affected_identifiers: { wallets: 3 },
  financial_impact_myr: 12000,
  customers_affected_count: 3,
  merchants_affected_count: 0,
  data_records_affected_count: 3,
  downtime_minutes: 0,
  contained_at: "2026-09-20T03:00:00Z",
  recovered_at: "2026-09-20T05:00:00Z",
  resumed_at: "2026-09-20T05:30:00Z",
  closed_at: "2026-09-25T09:00:00Z",
  root_cause: "Credential-stuffing attack against reused passwords.",
  closed_by: "u2",
  pir_due_at: "2026-10-05T09:00:00Z",
  escalation_level: 2,
  escalation_level_entered_at: "2026-09-20T01:30:00Z",
  next_escalation_due_at: null,
  custom_fields: {},
  created_at: "2026-09-20T01:00:00Z",
  updated_at: "2026-09-25T09:00:00Z",
  incident_start_time: "2026-09-19T23:00:00Z",
  recipient_directly_affected: "no",
  containment_summary: "Forced password reset for affected accounts.",
  eradication_summary: "Rotated leaked credentials.",
  recovery_summary: "Wallet transfers restored, monitoring added.",
  vendor_involvement: null,
  attack_vector: "Credential stuffing via a leaked third-party password list.",
  threat_actor_info: null,
  children_data_involved: "no",
  contributing_factors: ["people", "technology"],
  contributing_factors_detail: "Weak password policy plus no anomaly detection on login patterns.",
  pir_method: "5_whys",
  what_worked_well: "Fast containment once flagged by the customer.",
  what_did_not_work_well: "No automated alert fired before the customer reported it.",
  funds_recovered_myr: 8000,
  funds_recovered_at: "2026-09-22",
  end_of_hypercare_at: "2026-09-27T00:00:00Z",
  pir_review_meeting_at: "2026-09-28T10:00:00Z",
  pir_review_attendees: "Incident Lead, CEO, Head of Engineering",
};

const ctx: IncidentDocumentContext = {
  incident,
  actions: [
    { id: "a1", incident_id: "inc-1", description: "Add anomaly detection on login patterns", owner_id: "u2", due_date: "2026-10-15", status: "open", closed_at: null, created_by: "u2", created_at: "2026-09-25T09:00:00Z", updated_at: "2026-09-25T09:00:00Z" },
  ],
  notificationsSent: [
    { id: "n1", incident_id: "inc-1", recipient_party: "bnm", recipient_detail: null, method: "Email", reference: "REF-1", sent_at: "2026-09-20T02:00:00Z", recorded_by: "u2", created_at: "2026-09-20T02:00:00Z" },
  ],
  attachments: [
    { id: "att1", incident_id: "inc-1", comment_id: null, storage_path: "x", url: "https://example.com/x.png", filename: "screenshot.png", mime_type: "image/png", size_bytes: 1000, uploaded_by: "u1", created_at: "2026-09-20T01:10:00Z", file_hash: "deadbeef", evidenceDescription: "Screenshot of the alert" },
  ],
  escalationEvents: [
    { id: "e1", incident_id: "inc-1", from_level: 1, to_level: 2, reason: "auto_timeout", triggered_by: null, created_at: "2026-09-20T01:20:00Z" },
  ],
  reporterName: "Alex Tan",
  incidentLeadName: "Jamie Lee",
  accountContact: { name: "Jamie Lee", role: "ISO", mobile: "+60123456789", email: "iso@vircle.tech" },
  escalationTargetMinutes: { level1: 15, level2: 60 },
  lastGenerated: { a: "2026-09-20T01:15:00Z", b: null },
};

/** A generated .docx is a zip; its main content lives at word/document.xml. */
async function extractDocumentXml(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const file = zip.file("word/document.xml");
  expect(file).toBeTruthy();
  return file!.async("string");
}

describe("incident document generators", () => {
  it("Form A: valid docx, contains the incident key, severity and section headings", async () => {
    const buffer = await buildFormADocx(ctx, {
      preparedByName: "Alex Tan",
      preparedByRole: "Support Lead",
      recipients: ["bnm"],
      otherPartiesNotified: ["none_yet"],
    });
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    const xml = await extractDocumentXml(buffer);
    expect(xml).toContain("INC-2026-42");
    expect(xml).toContain("P1");
    expect(xml).toContain("1 Reference");
    expect(xml).toContain("5 Actions");
  });

  it("Form B: valid docx, contains the executive summary and evidence hash", async () => {
    const buffer = await buildFormBDocx(ctx, {
      preparedByName: "Alex Tan",
      preparedByRole: "Support Lead",
      executiveSummary: "A credential-stuffing incident affecting three wallets was contained within two hours.",
      timeline: [{ at: "2026-09-20T01:00:00Z", event: "Detected", by: "Monitoring" }],
      nextStepsContact: { name: "Jamie Lee", role: "ISO" },
    });
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    const xml = await extractDocumentXml(buffer);
    expect(xml).toContain("credential-stuffing");
    expect(xml).toContain("deadbeef");
    expect(xml).toContain("9 Evidence attached");
  });

  it("Form C: valid docx, contains root cause and the corrective action", async () => {
    const buffer = await buildFormCDocx(ctx, {
      preparedByName: "Jamie Lee",
      preparedByRole: "ISO",
      timelinessRows: [{ label: "L1 acknowledgement", required: "15 min", actual: "12 min", met: true }],
    });
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
    const xml = await extractDocumentXml(buffer);
    expect(xml).toContain("Credential-stuffing attack");
    expect(xml).toContain("anomaly detection");
    expect(xml).toContain("6 Corrective and preventive actions");
  });

  it("Form D: valid docx, contains the closure section only for a final notice", async () => {
    const statusUpdate = await buildFormDDocx(ctx, {
      preparedByName: "Jamie Lee",
      preparedByRole: "ISO",
      updateType: "status_update",
      changesSinceLastUpdate: "Wallet transfers restored, monitoring active.",
    });
    const finalNotice = await buildFormDDocx(ctx, {
      preparedByName: "Jamie Lee",
      preparedByRole: "ISO",
      updateType: "final_closure",
      changesSinceLastUpdate: "Incident closed, hypercare ended.",
    });
    expect(statusUpdate.subarray(0, 2).toString()).toBe("PK");
    const statusXml = await extractDocumentXml(statusUpdate);
    const finalXml = await extractDocumentXml(finalNotice);
    expect(statusXml).not.toContain("5 Closure");
    expect(finalXml).toContain("5 Closure");
    expect(finalXml).toContain("6 Next contact");
  });
});
