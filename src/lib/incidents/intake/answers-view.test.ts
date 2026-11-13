import { describe, expect, it } from "vitest";

import { answerLines, involvedCount } from "./answers-view";
import { CCA_FORM } from "./form-schema";

describe("answerLines", () => {
  const answers = { involved: { ids: ["S-1"], others: ["Mr Visitor"] }, kind: "injury", what: " Twisted ankle ", severity: "first_aid", body_part: "leg", head_injury: false };

  it("labels each answered question with the wording of the form it was filed under", () => {
    expect(answerLines(CCA_FORM, answers)).toEqual([
      { key: "kind", label: "What kind of incident was it?", value: "Injury" },
      { key: "what", label: "Tell us what happened", value: "Twisted ankle" },
      { key: "severity", label: "How serious was it?", value: "Needs first aid or the nurse" },
      { key: "body_part", label: "Where was the injury?", value: "Leg or foot" },
      { key: "head_injury", label: "Did the student hit their head, or seem dazed or confused?", value: "No" },
    ]);
  });
  it("leaves out questions that were hidden or not answered, and the people and photo fields", () => {
    const lines = answerLines(CCA_FORM, { involved: { ids: [], others: [] }, kind: "damage", what: "Goal post", severity: "minor", body_part: "arm" });
    expect(lines.map((l) => l.key)).toEqual(["kind", "what", "severity"]);
  });
  it("reads an option that no longer exists as its stored value, and picks the language", () => {
    expect(answerLines(CCA_FORM, { kind: "volcano", what: "x" })[0].value).toBe("volcano");
    expect(answerLines(CCA_FORM, { kind: "injury", what: "x" }, "ms")[0]).toEqual({ key: "kind", label: "Apakah jenis insiden ini?", value: "Kecederaan" });
  });
  it("counts the people named", () => {
    expect(involvedCount(answers)).toBe(2);
    expect(involvedCount({})).toBe(0);
  });
});
