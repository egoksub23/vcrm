import type { HelpFrontmatter } from "./types";

// Deliberately tiny frontmatter reader instead of a YAML dependency. Pages only
// use flat `key: value` lines, and being forgiving (a colon inside a description
// is fine, quotes are optional) is kinder to writers than strict YAML.

export interface ParsedFrontmatter {
  data: Record<string, string>;
  body: string;
}

export type FrontmatterResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

const FENCE = /^---[ \t]*$/;

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      const inner = v.slice(1, -1);
      return first === '"'
        ? inner.replace(/\\"/g, '"').replace(/\\\\/g, "\\")
        : inner.replace(/''/g, "'");
    }
  }
  // Plain scalar: a trailing " # comment" is dropped.
  return v.replace(/\s+#.*$/, "").trim();
}

/** Split a file into frontmatter key/values and the Markdown body. */
export function splitFrontmatter(raw: string): FrontmatterResult<ParsedFrontmatter> {
  const text = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const lines = text.split("\n");
  if (!FENCE.test(lines[0] ?? "")) {
    return { ok: false, error: "the file must start with a --- frontmatter block" };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { ok: false, error: "the frontmatter block is not closed with ---" };
  }
  const data: Record<string, string> = {};
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = /^([A-Za-z][A-Za-z0-9_-]*)[ \t]*:(.*)$/.exec(line);
    if (!m) {
      return { ok: false, error: `frontmatter line ${i + 1} is not "key: value": ${line.trim()}` };
    }
    data[m[1]] = unquote(m[2]);
  }
  return { ok: true, value: { data, body: lines.slice(end + 1).join("\n").replace(/^\n+/, "") } };
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Check the required keys and their types. */
export function validateFrontmatter(
  data: Record<string, string>,
): FrontmatterResult<HelpFrontmatter> {
  const title = data.title?.trim();
  if (!title) return { ok: false, error: "frontmatter is missing a title" };
  const description = data.description?.trim();
  if (!description) return { ok: false, error: "frontmatter is missing a description" };
  const orderRaw = data.order?.trim();
  if (orderRaw === undefined || orderRaw === "") {
    return { ok: false, error: "frontmatter is missing an order" };
  }
  if (!/^\d+$/.test(orderRaw)) {
    return { ok: false, error: `order must be a whole number, got "${orderRaw}"` };
  }
  const value: HelpFrontmatter = { title, description, order: Number(orderRaw) };
  if (data.updated !== undefined && data.updated !== "") {
    if (!isValidIsoDate(data.updated)) {
      return { ok: false, error: `updated must be an ISO date (YYYY-MM-DD), got "${data.updated}"` };
    }
    value.updated = data.updated;
  }
  return { ok: true, value };
}

export function parseFrontmatter(raw: string): FrontmatterResult<{ meta: HelpFrontmatter; body: string }> {
  const split = splitFrontmatter(raw);
  if (!split.ok) return split;
  const meta = validateFrontmatter(split.value.data);
  if (!meta.ok) return meta;
  return { ok: true, value: { meta: meta.value, body: split.value.body } };
}
