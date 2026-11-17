import { describe, expect, it } from "vitest";

import { filedReportFileName, filedReportStamp } from "./filed-report-name";

describe("filedReportFileName", () => {
  const at = new Date("2026-11-17T00:52:00Z"); // 08:52 in Kuala Lumpur

  it("is incident number, type and the time the PDF was made, in the school's time zone", () => {
    expect(filedReportFileName("INC-2026-8", "Injury", at, "Asia/Kuala_Lumpur")).toBe("INC-2026-8-Injury-20261117-0852.pdf");
  });

  it("turns a type name with spaces and symbols into plain file-name text", () => {
    expect(filedReportFileName("INC-2026-12", "Child welfare / safeguarding", at, "Asia/Kuala_Lumpur")).toBe("INC-2026-12-Child-welfare-safeguarding-20261117-0852.pdf");
    expect(filedReportFileName("INC-1", "Café Ünïcode", at, "UTC")).toBe("INC-1-Cafe-Unicode-20261117-0052.pdf");
  });

  it("uses UTC when the time zone is not valid, and never produces an empty part", () => {
    expect(filedReportStamp(at, "Not/AZone")).toBe("20261117-0052");
    expect(filedReportFileName("", "日本語", at, "UTC")).toBe("incident-incident-20261117-0052.pdf");
  });

  it("changes the day at local midnight, not at UTC midnight", () => {
    expect(filedReportStamp(new Date("2026-11-16T17:30:00Z"), "Asia/Kuala_Lumpur")).toBe("20261117-0130");
  });
});
