import { describe, expect, it } from "vitest";

import { SignError } from "@/lib/sign/service/errors";

import { parseCreateBody } from "./sign";

// `copy_to` of POST /api/v1/sign/documents (migration 175): people who receive the signed copy by email and are not signers.

const TEMPLATE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const body = (over: Record<string, unknown> = {}) => ({
  template_id: TEMPLATE,
  signers: [{ role_key: "merchant", full_name: "Ali", email: "ali@kedai.example" }],
  ...over,
});
const issuesOf = (b: Record<string, unknown>): { field?: string; detail?: string; code: string }[] => {
  try {
    parseCreateBody(b);
  } catch (err) {
    expect(err).toBeInstanceOf(SignError);
    return (err as SignError).issues ?? [];
  }
  return [];
};
const fields = (b: Record<string, unknown>) => issuesOf(b).map((i) => i.field);

describe("parseCreateBody: copy_to", () => {
  it("takes a list of names and addresses, trimmed, and none at all (absent or null) as an empty list", () => {
    expect(parseCreateBody(body()).copyTo).toEqual([]);
    expect(parseCreateBody(body({ copy_to: null })).copyTo).toEqual([]);
    expect(parseCreateBody(body({ copy_to: [] })).copyTo).toEqual([]);
    expect(parseCreateBody(body({ copy_to: [{ full_name: "  Cara Lim ", email: " cara@kedai.example " }, { full_name: "Dev", email: "dev@kedai.example" }] })).copyTo).toEqual([
      { fullName: "Cara Lim", email: "cara@kedai.example" },
      { fullName: "Dev", email: "dev@kedai.example" },
    ]);
  });

  it("takes ten and refuses more, naming the field", () => {
    const people = (n: number) => Array.from({ length: n }, (_, i) => ({ full_name: `P${i}`, email: `p${i}@kedai.example` }));
    expect(parseCreateBody(body({ copy_to: people(10) })).copyTo).toHaveLength(10);
    expect(issuesOf(body({ copy_to: people(11) }))).toEqual([{ code: "invalid", field: "copy_to", detail: "can have up to 10 people" }]);
  });

  it("refuses what is not a list of people, with the index of the person and the field", () => {
    expect(fields(body({ copy_to: "cara@kedai.example" }))).toEqual(["copy_to"]);
    expect(fields(body({ copy_to: { full_name: "x" } }))).toEqual(["copy_to"]);
    expect(fields(body({ copy_to: ["cara@kedai.example"] }))).toEqual(["copy_to[0]"]);
    expect(fields(body({ copy_to: [{ full_name: "Cara", email: "cara@kedai.example" }, { full_name: " ", email: "nope" }] }))).toEqual(["copy_to[1].full_name", "copy_to[1].email"]);
    expect(fields(body({ copy_to: [{ full_name: "x".repeat(161), email: "x@kedai.example" }] }))).toEqual(["copy_to[0].full_name"]);
    expect(fields(body({ copy_to: [{ full_name: "Cara", email: 42 }] }))).toEqual(["copy_to[0].email"]);
  });

  it("refuses an address that is on the list twice, and the address of a signer, whatever the letter case", () => {
    const dup = issuesOf(body({ copy_to: [{ full_name: "A", email: "x@kedai.example" }, { full_name: "B", email: "X@KEDAI.example" }] }));
    expect(dup).toHaveLength(1);
    expect(dup[0]).toMatchObject({ code: "invalid", field: "copy_to[1].email" });
    expect(dup[0].detail).toContain("already on the list");
    const signer = issuesOf(body({ copy_to: [{ full_name: "Ali", email: "ALI@kedai.example" }] }));
    expect(signer.map((i) => i.field)).toEqual(["copy_to[0].email"]);
  });

  it("reports the problems of the people with the rest of the request in one answer", () => {
    expect(fields(body({ template_id: "nope", copy_to: [{ full_name: "", email: "x@kedai.example" }] }))).toEqual(["template_id", "copy_to[0].full_name"]);
  });
});
