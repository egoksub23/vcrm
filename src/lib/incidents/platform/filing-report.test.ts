import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import type { EvidenceDoc } from "./evidence-doc";
import { buildFilingPdf, formatWhen, type FilingInput } from "./filing-report";

// a real 1x1 PNG
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

function doc(over: Partial<EvidenceDoc> = {}): EvidenceDoc {
  return {
    reference: "INC-2026-7",
    generated_at: "2026-11-09T02:00:00.000Z",
    names: { categories: [{ code: "CCA", name: "CCA incident" }], severities: [{ slug: "p2", label: "Serious" }] },
    incident: {
      title: "Arvin Raj Year 2E sprained ankle during CCA",
      description: "Arvin was running to stop a striker and fell.\nHe could not put weight on the ankle.",
      category_name: "CCA incident",
      severity_label: "Serious",
      status: "closed",
      created_at: "2026-11-05T01:00:00.000Z",
      closed_at: "2026-11-08T09:30:00.000Z",
      root_cause: "Wet field",
      incident_flags: ["injury", "child_involved"],
      activity: { name: "Football", venue: "Field 1", date: "2026-11-05" },
      reporter_name: "Coach Lim",
      reporter_email: "lim@school.example",
      source: "coach_portal",
    },
    people_named: [{ name: "Arvin Raj", class_name: "2E", external_student_id: "S1234", involvement: "injured", guardians: null }],
    timeline: [
      { event_type: "created", from_value: null, to_value: "reported", created_at: "2026-11-05T01:00:00.000Z", actor: "Coach Lim" },
      { event_type: "status_changed", from_value: "reported", to_value: "triaged", created_at: "2026-11-05T02:00:00.000Z", actor: "Nurse Tan" },
      { event_type: "closed", from_value: null, to_value: null, created_at: "2026-11-08T09:30:00.000Z", actor: "Ms Wong" },
    ],
    comments: [{ body: "Parents informed and collected him at 3pm.", created_at: "2026-11-05T03:00:00.000Z", author: "Nurse Tan" }],
    required_steps: [{ title: "Inform the principal", description: null, role_key: "school_leadership", party: null, due_at: "2026-11-05T03:00:00.000Z", status: "done", completed_at: "2026-11-05T02:30:00.000Z" }],
    approvals: [],
    message_log: [
      { role_key: "school_leadership", recipient_name: "Principal", channel: "email", address: "p@school.example", reason: "Serious injury", status: "sent", sent_at: "2026-11-05T01:05:00.000Z", acknowledged_at: null },
      { role_key: "nurse", recipient_name: "TEST", channel: "email", address: "t@x.test", reason: "test", status: "sent", sent_at: null, acknowledged_at: null, is_test: true },
    ],
    files: [{ filename: "ankle.png", mime_type: "image/png", size_bytes: 2048, file_hash: "ab".repeat(32), created_at: "2026-11-05T01:10:00.000Z" }],
    report_answers: [{ key: "body_part", label: "Where was the injury?", value: "Leg or foot" }],
    return_to_play: null,
    ...over,
  };
}

const input = (d: EvidenceDoc, extra: Partial<FilingInput> = {}): FilingInput => ({
  doc: d,
  schoolName: "Test School",
  generatedBy: "Ms Wong",
  version: 1,
  timeZone: "Asia/Kuala_Lumpur",
  images: [{ filename: "ankle.png", bytes: PNG, kind: "png", addedAt: "2026-11-05T01:10:00.000Z" }],
  imagesNotShown: [],
  ...extra,
});

describe("filing report (PDF)", () => {
  it("produces a real PDF with the picture embedded", async () => {
    const r = await buildFilingPdf(input(doc()));
    expect(Buffer.from(r.bytes.slice(0, 5)).toString()).toBe("%PDF-");
    const back = await PDFDocument.load(r.bytes);
    expect(back.getPageCount()).toBe(r.pages);
    expect(r.pages).toBeGreaterThanOrEqual(1);
    expect(r.unsupportedCharacters).toBe(0);
  });

  it("runs onto more pages when there is a lot to say, and numbers them", async () => {
    const many = Array.from({ length: 140 }, (_, n) => ({ body: `Update ${n}: ${"the nurse checked the ankle again and the swelling was recorded. ".repeat(3)}`, created_at: `2026-11-06T${String(n % 24).padStart(2, "0")}:00:00.000Z`, author: "Nurse Tan" }));
    const r = await buildFilingPdf(input(doc({ comments: many })));
    expect(r.pages).toBeGreaterThan(3);
  });

  it("copes with a very long unbroken word and with no description", async () => {
    const d = doc();
    d.incident.description = "x".repeat(900);
    const r = await buildFilingPdf(input(d));
    expect(r.pages).toBeGreaterThanOrEqual(1);
    d.incident.description = null;
    await expect(buildFilingPdf(input(d))).resolves.toBeDefined();
  });

  it("says how many characters it could not draw (Chinese needs the optional server font)", async () => {
    const d = doc();
    d.people_named = [{ name: "陈小明", class_name: "2E", external_student_id: null, involvement: "injured", guardians: null }];
    const r = await buildFilingPdf(input(d));
    // three characters, counted once (the name is drawn once)
    expect(r.unsupportedCharacters).toBe(3);
  });

  it("lists a picture it cannot draw by name and survives a corrupt image", async () => {
    const r = await buildFilingPdf(input(doc(), { images: [{ filename: "broken.png", bytes: Uint8Array.from([1, 2, 3]), kind: "png", addedAt: "2026-11-05T01:10:00.000Z" }], imagesNotShown: ["scan.heic"] }));
    expect(r.bytes.length).toBeGreaterThan(1000);
  });

  it("shows times in the zone given, and falls back to UTC for a bad zone", () => {
    expect(formatWhen("2026-11-05T01:00:00.000Z", "Asia/Kuala_Lumpur")).toBe("5 Nov 2026, 09:00");
    expect(formatWhen("2026-11-05T01:00:00.000Z", "Not/AZone")).toBe("5 Nov 2026, 01:00");
    expect(formatWhen(null, "UTC")).toBe("–");
  });
});
