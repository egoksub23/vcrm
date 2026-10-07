import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The e-signing module is called Secure Sign (it was Doc Sign, and Vircle Doc Sign on the signing page). Everything a person reads must say so:
// the messages of every language, the strings in the source (emails, errors, labels, the signing page's header, the sealed PDF's own text), and
// the help articles. Code comments, tests, migrations, the CHANGELOG and the text of documents that were already sealed are history and are not
// scanned. A deliberate exception goes in ALLOWED with the reason; there is none today.

const ROOT = process.cwd();
const OLD = /doc sign/i;

/** `file` -> why a line may still say it (nothing today). */
const ALLOWED: Record<string, string> = {};

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, accept, out);
    else if (accept(full)) out.push(full);
  }
  return out;
}

const COMMENT_LINE = /^\s*(\/\/|\*|\/\*|\{\/\*)/;
const rel = (f: string) => relative(ROOT, f).replace(/\\/g, "/");

/** The lines of a source file that are not comments (a trailing `// ...` is dropped too). */
function codeLines(file: string): { line: number; text: string }[] {
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((text, i) => ({ line: i + 1, text }))
    .filter((l) => !COMMENT_LINE.test(l.text))
    .map((l) => ({ line: l.line, text: l.text.replace(/\s\/\/\s.*$/, "") }));
}

function leaves(node: unknown, path = ""): { path: string; value: string }[] {
  if (typeof node === "string") return [{ path, value: node }];
  if (node && typeof node === "object") return Object.entries(node).flatMap(([k, v]) => leaves(v, path ? `${path}.${k}` : k));
  return [];
}

describe("the product is called Secure Sign wherever a person reads it", () => {
  for (const locale of ["en", "ms", "zh", "ko", "es", "pt"]) {
    it(`has no Doc Sign in messages/${locale}.json`, () => {
      const m = JSON.parse(readFileSync(join(ROOT, "messages", `${locale}.json`), "utf8")) as unknown;
      const bad = leaves(m).filter((l) => OLD.test(l.value) && !ALLOWED[`messages/${locale}.json:${l.path}`]);
      expect(bad.map((b) => `${b.path}: ${b.value.slice(0, 80)}`)).toEqual([]);
    });
  }

  it("says Secure Sign in the names of the module in every language (sidebar, page header, permission group, settings tab, back link, and the Platform console)", () => {
    const at = (m: unknown, path: string) => path.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown>)[k], m);
    for (const locale of ["en", "ms", "zh", "ko"]) {
      const m = JSON.parse(readFileSync(join(ROOT, "messages", `${locale}.json`), "utf8")) as unknown;
      for (const path of ["Sidebar.sign", "Header.sign", "Permissions.group.sign", "Sign.admin.settingsTab", "Sign.admin.title", "Sign.detail.header.back", "Sign.send.shell.title"]) {
        expect(at(m, path), `${locale} ${path}`).toBe("Secure Sign");
      }
      // the operator's console is worded in English and Korean only
      if (locale === "en" || locale === "ko") expect(at(m, "Platform.feature_sign")).toBe("Secure Sign");
    }
  });

  it("has no Doc Sign in the strings of the source (emails and their subjects and footers, errors, labels, the signing page, the sealed PDF's text)", () => {
    const files = walk(join(ROOT, "src"), (f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f));
    expect(files.length).toBeGreaterThan(500);
    const bad: string[] = [];
    for (const f of files) {
      for (const l of codeLines(f)) if (OLD.test(l.text) && !ALLOWED[`${rel(f)}:${l.line}`]) bad.push(`${rel(f)}:${l.line}: ${l.text.trim().slice(0, 100)}`);
    }
    expect(bad).toEqual([]);
  });

  it("has no Doc Sign in the help articles of the module (their file names and addresses stay)", () => {
    const dir = join(ROOT, "content", "help", "doc-sign");
    const files = walk(dir, (f) => /\.(md|json)$/.test(f));
    expect(files.length).toBeGreaterThan(20);
    const bad: string[] = [];
    for (const f of files) {
      readFileSync(f, "utf8")
        .split(/\r?\n/)
        // a link to an article keeps its address, which holds the old words; only the visible text is checked
        .map((text) => text.replace(/\]\([^)]*\)/g, "]()"))
        .forEach((text, i) => {
          if (OLD.test(text) && !ALLOWED[`${rel(f)}:${i + 1}`]) bad.push(`${rel(f)}:${i + 1}: ${text.slice(0, 100)}`);
        });
    }
    expect(bad).toEqual([]);
  });

  it("heads the signing page, the verify page and the registration page with Vircle Secure Sign", () => {
    const shell = readFileSync(join(ROOT, "src", "components", "sign", "signer", "shell.tsx"), "utf8");
    expect(shell).toContain("Vircle Secure Sign");
    expect(shell).not.toContain("Vircle Doc Sign");
  });

  it("names the product in the emails of every language, and the text of the PDF a document is sealed with", () => {
    const messages = readFileSync(join(ROOT, "src", "lib", "sign", "messages.ts"), "utf8");
    expect(messages.match(/Vircle Secure Sign/g)?.length).toBe(4);
    expect(messages.match(/Secure Sign/g)?.length).toBeGreaterThanOrEqual(12);
    const seal = readFileSync(join(ROOT, "src", "lib", "sign", "pdf", "seal.ts"), "utf8");
    expect(seal).toContain("Sealed by Vircle Secure Sign");
    expect(readFileSync(join(ROOT, "src", "lib", "sign", "service", "seal.ts"), "utf8")).toContain("through Vircle Secure Sign");
  });
});
