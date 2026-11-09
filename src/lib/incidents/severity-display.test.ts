import { describe, expect, it } from "vitest";

import { severityText } from "./severity-display";

const school = [
  { slug: "critical", label: "Critical" },
  { slug: "high", label: "High" },
  { slug: "medium", label: "Medium" },
  { slug: "low", label: "Low" },
];

describe("severityText", () => {
  it("numbers a school's named levels from the most serious", () => {
    expect(severityText("critical", school)).toBe("P1 · Critical");
    expect(severityText("high", school)).toBe("P2 · High");
    expect(severityText("low", school)).toBe("P4 · Low");
  });
  it("leaves the bank's own P1 to P4 as they are", () => {
    expect(severityText("P2", [{ slug: "P2", label: "Major" }])).toBe("P2 · Major");
    expect(severityText("P3", [{ slug: "P3", label: "P3" }])).toBe("P3");
  });
  it("falls back to the plain slug when the template is not known", () => {
    expect(severityText("high", null)).toBe("high");
    expect(severityText("nope", school)).toBe("nope");
  });
});
