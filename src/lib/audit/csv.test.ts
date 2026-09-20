import { describe, expect, it } from "vitest";

import { csvEntryLines, csvHeaderLine, EXPORT_MAX_ROWS } from "./csv";
import type { AuditEntry } from "./types";

const entry = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  id: "1",
  createdAt: "2026-09-20T10:00:00.000Z",
  actor: { id: "u1", kind: "user", name: "Maya" },
  action: "updated",
  entityType: "tag",
  entityId: "t1",
  entityLabel: "VIP",
  summary: { changes: { name: { from: "VIP", to: "VIP gold" } } },
  entityExists: true,
  ...over,
});

describe("audit CSV", () => {
  it("has a fixed header and a 10,000 row cap", () => {
    expect(csvHeaderLine()).toBe(
      "Time (UTC),Actor,Actor type,Action,Item type,Item,Item ID,Details\r\n",
    );
    expect(EXPORT_MAX_ROWS).toBe(10_000);
  });

  it("writes one CRLF line per entry with the summary as text", () => {
    expect(csvEntryLines([entry()])).toBe(
      '2026-09-20T10:00:00.000Z,Maya,user,updated,tag,VIP,t1,"renamed ""VIP"" to ""VIP gold"""\r\n',
    );
    expect(csvEntryLines([])).toBe("");
  });

  it("guards cells that start with = + - @ against formula injection", () => {
    const out = csvEntryLines([
      entry({
        actor: { id: null, kind: "api", name: '=HYPERLINK("http://evil")' },
        entityLabel: "+1 tag",
        summary: null,
      }),
      entry({ entityLabel: "-2+3" }),
      entry({ entityLabel: "@SUM(A1)" }),
    ]);
    const lines = out.trimEnd().split("\r\n");
    expect(lines[0]).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(lines[0]).toContain(",'+1 tag,");
    expect(lines[1]).toContain(",'-2+3,");
    expect(lines[2]).toContain(",'@SUM(A1),");
  });

  it("quotes commas and line breaks in names", () => {
    const out = csvEntryLines([entry({ entityLabel: "Refunds, returns\nand more" })]);
    expect(out).toContain('"Refunds, returns\nand more"');
  });
});
