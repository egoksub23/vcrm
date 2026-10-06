// Doc Sign registration forms: the messages, for tests. `Sign.register` (the public page) and `Sign.admin` (Settings) from
// messages/<locale>.json. While the orchestrator has not yet merged this work package's fragments into those files, a
// test can be pointed at the fragments (a folder holding register-wp21.json and admin-wp21.json, each
// { en, ms, zh, ko }) with SIGN_I18N_FRAGMENTS=<folder>; they are laid over the catalogue in memory and nothing is
// written. With neither, the helpers return null and the tests that need the words are skipped.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const REGISTER_LOCALES = ["en", "ms", "zh", "ko"] as const;
export type RegisterLocale = (typeof REGISTER_LOCALES)[number];
export type Tree = { [key: string]: unknown };

const isTree = (v: unknown): v is Tree => typeof v === "object" && v !== null && !Array.isArray(v);

function merge(into: Tree, extra: Tree): Tree {
  const out: Tree = { ...into };
  for (const [k, v] of Object.entries(extra)) out[k] = isTree(v) && isTree(out[k]) ? merge(out[k] as Tree, v) : v;
  return out;
}

function catalogue(locale: RegisterLocale): Tree {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as Tree;
  } catch {
    return {};
  }
}

function fragment(name: string): Record<RegisterLocale, Tree> | null {
  const dir = process.env.SIGN_I18N_FRAGMENTS;
  if (!dir) return null;
  const file = join(dir, name);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Record<RegisterLocale, Tree>;
  } catch {
    return null;
  }
}

/** The whole `Sign` tree of a language, with a fragment laid over it when there is one. */
function signTree(locale: RegisterLocale, fragmentName: string, area: string): Tree {
  const sign = (catalogue(locale).Sign as Tree | undefined) ?? {};
  const extra = fragment(fragmentName)?.[locale];
  return extra ? merge(sign, { [area]: extra }) : sign;
}

/** `Sign.register` per language, or null when it is not there. */
export function readRegisterMessages(): Record<RegisterLocale, Tree> | null {
  const out: Partial<Record<RegisterLocale, Tree>> = {};
  for (const l of REGISTER_LOCALES) {
    const t = signTree(l, "register-wp21.json", "register").register;
    if (!isTree(t)) return null;
    out[l] = t;
  }
  return out as Record<RegisterLocale, Tree>;
}

/** `Sign.admin` per language (with this work package's additions), or null when the registration part is not there. */
export function readAdminMessages(): Record<RegisterLocale, Tree> | null {
  const out: Partial<Record<RegisterLocale, Tree>> = {};
  for (const l of REGISTER_LOCALES) {
    const t = signTree(l, "admin-wp21.json", "admin").admin;
    if (!isTree(t) || !isTree(t.registration)) return null;
    out[l] = t;
  }
  return out as Record<RegisterLocale, Tree>;
}

/** Every leaf of a tree, by dotted path. */
export function leaves(node: unknown, path = ""): Map<string, string> {
  const out = new Map<string, string>();
  if (isTree(node)) for (const [k, v] of Object.entries(node)) for (const [p, s] of leaves(v, path ? `${path}.${k}` : k)) out.set(p, s);
  else out.set(path, String(node));
  return out;
}

export const placeholders = (s: string): string[] => [...new Set([...s.matchAll(/\{(\w+)/g)].map((m) => m[1]))].sort();
