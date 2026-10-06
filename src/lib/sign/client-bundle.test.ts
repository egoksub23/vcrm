import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

import { describe, expect, it } from "vitest";

// The browser bundle of a Doc Sign screen must not reach a module that needs Node (the PDF engine reads font files, the add-on
// installer reads template files). Unit tests cannot see this: it only fails in `next build`, as "the chunking context does not
// support external modules (request: node:fs/promises)". This follows the value imports (type-only imports are erased) from every
// client entry point and fails when one reaches a file that imports a Node built-in.

const SRC = join(process.cwd(), "src");
const IMPORT = /^\s*(?:import|export)\s+(type\s+)?(?:[^"';]*?\s+from\s+)?["']([^"']+)["']/gm;
const NODE_BUILTIN = /(?:from|import\()\s*["'](?:node:[a-z/]+|fs|fs\/promises|path|crypto|child_process)["']/;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name) ? [p] : [];
  });
}

function resolveImport(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? normalize(join(dirname(from), spec)) : null;
  if (!base) return null;
  for (const candidate of [base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx"), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const source = new Map<string, string>();
const text = (f: string) => {
  let s = source.get(f);
  if (s === undefined) source.set(f, (s = readFileSync(f, "utf8")));
  return s;
};

function valueImports(file: string): string[] {
  const out: string[] = [];
  for (const m of text(file).matchAll(IMPORT)) {
    if (m[1]) continue; // `import type` is erased
    const resolved = resolveImport(file, m[2]);
    if (resolved) out.push(resolved);
  }
  return out;
}

/** The first chain from `entry` to a file that imports a Node built-in, or null. */
function nodeChain(entry: string): string[] | null {
  const prev = new Map<string, string | null>([[entry, null]]);
  const queue = [entry];
  while (queue.length) {
    const f = queue.shift()!;
    if (NODE_BUILTIN.test(text(f))) {
      const chain: string[] = [];
      for (let x: string | null = f; x; x = prev.get(x) ?? null) chain.push(relative(SRC, x));
      return chain.reverse();
    }
    for (const d of valueImports(f)) {
      if (!prev.has(d)) {
        prev.set(d, f);
        queue.push(d);
      }
    }
  }
  return null;
}

const CLIENT_DIRS = [join(SRC, "components", "sign"), join(SRC, "components", "settings", "sign"), join(SRC, "lib", "sign", "client")];
const HOOKS = readdirSync(join(SRC, "hooks")).filter((n) => /^use-sign.*\.tsx?$/.test(n) && !/\.test\./.test(n)).map((n) => join(SRC, "hooks", n));

describe("the browser side of Doc Sign never reaches a Node-only module", () => {
  const entries = [...CLIENT_DIRS.flatMap(walk), ...HOOKS].filter((f) => !/test-messages|fixtures/.test(f)) // helpers that only the tests load
    .filter((f) => f.includes(join("lib", "sign", "client")) || /^\s*["']use client["']/.test(text(f)));

  it("finds the client entry points", () => {
    expect(entries.length).toBeGreaterThan(100);
  });

  it("has no path from a client file to a file that imports fs, path, crypto or a node: module", () => {
    const bad: string[] = [];
    for (const entry of entries) {
      const chain = nodeChain(entry);
      if (chain) bad.push(chain.join(" -> "));
    }
    expect(bad).toEqual([]);
  });
});
