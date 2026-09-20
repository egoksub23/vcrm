import { describe, expect, it } from "vitest";

import {
  applyAuditFilters,
  decodeCursor,
  encodeCursor,
  escapeLike,
  parseAuditFilters,
} from "./filters";
import { EMPTY_AUDIT_FILTERS } from "./types";

const ID = "3f2b8c1e-5a4d-4e7b-9c10-0a1b2c3d4e5f";
const TS = "2026-09-20T10:09:26.967047+00:00";

const parse = (qs: string) => parseAuditFilters(new URLSearchParams(qs));

describe("parseAuditFilters", () => {
  it("accepts no filters at all", () => {
    expect(parse("")).toEqual({ ok: true, filters: EMPTY_AUDIT_FILTERS });
  });

  it("reads every filter", () => {
    const r = parse(
      `actor=${ID}&action=deleted&entity_type=tag&from=2026-09-01T00:00:00Z&to=2026-09-20T00:00:00Z&q=%20vip%20`,
    );
    expect(r).toEqual({
      ok: true,
      filters: {
        actor: ID,
        action: "deleted",
        entityType: "tag",
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-20T00:00:00.000Z",
        q: "vip",
      },
    });
  });

  it("accepts a non-user actor kind", () => {
    expect(parse("actor=system")).toMatchObject({ ok: true, filters: { actor: "system" } });
    expect(parse("actor=api")).toMatchObject({ ok: true });
  });

  it("refuses anything malformed rather than widening the query", () => {
    for (const qs of [
      "actor=maya",
      "action=explode",
      "entity_type=users",
      "from=yesterday",
      "to=nope",
      "from=2026-09-20T00:00:00Z&to=2026-09-01T00:00:00Z",
    ]) {
      expect(parse(qs).ok, qs).toBe(false);
    }
  });

  it("caps the search text", () => {
    const r = parse(`q=${"a".repeat(500)}`);
    expect(r.ok && r.filters.q?.length).toBe(100);
  });
});

describe("cursor", () => {
  it("round-trips", () => {
    const c = { createdAt: TS, id: ID };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("treats empty as the first page", () => {
    expect(decodeCursor(null)).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  it("rejects anything that could inject into the or() expression", () => {
    for (const raw of [
      "garbage",
      `${TS}_not-a-uuid`,
      `2026-09-20_${ID}`,
      `${TS},id.gt.0_${ID}`,
      `${TS}) or (true_${ID}`,
    ]) {
      expect(decodeCursor(raw), raw).toBe("invalid");
    }
  });
});

describe("applyAuditFilters", () => {
  function recorder() {
    const calls: [string, ...string[]][] = [];
    const q: Record<string, (...a: string[]) => unknown> = {};
    for (const op of ["eq", "gte", "lt", "ilike", "or"]) {
      q[op] = (...a: string[]) => {
        calls.push([op, ...a]);
        return q;
      };
    }
    return { calls, q: q as never };
  }

  it("adds nothing for empty filters", () => {
    const { calls, q } = recorder();
    applyAuditFilters(q, EMPTY_AUDIT_FILTERS);
    expect(calls).toEqual([]);
  });

  it("maps each filter to its column", () => {
    const { calls, q } = recorder();
    applyAuditFilters(q, {
      actor: ID,
      action: "created",
      entityType: "article",
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-02T00:00:00.000Z",
      q: "50%_off",
    });
    expect(calls).toEqual([
      ["eq", "actor_id", ID],
      ["eq", "action", "created"],
      ["eq", "entity_type", "article"],
      ["gte", "created_at", "2026-09-01T00:00:00.000Z"],
      ["lt", "created_at", "2026-09-02T00:00:00.000Z"],
      ["ilike", "entity_label", "%50\\%\\_off%"],
    ]);
  });

  it("filters a non-user actor by kind, not id", () => {
    const { calls, q } = recorder();
    applyAuditFilters(q, { ...EMPTY_AUDIT_FILTERS, actor: "automation" });
    expect(calls).toEqual([["eq", "actor_kind", "automation"]]);
  });

  it("pages by (created_at, id) so rows written together are not skipped", () => {
    const { calls, q } = recorder();
    applyAuditFilters(q, EMPTY_AUDIT_FILTERS, { createdAt: TS, id: ID });
    expect(calls).toEqual([
      ["or", `created_at.lt.${TS},and(created_at.eq.${TS},id.lt.${ID})`],
    ]);
  });
});

describe("escapeLike", () => {
  it("escapes wildcards and the escape character", () => {
    expect(escapeLike("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });
});
