import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// ============================================================
// Every live-update subscription is scoped.
//
// An unfiltered `postgres_changes` subscription is delivered every change to the
// table from every customer, and the server checks row security for each
// subscriber on each one. So each subscription must carry a `filter`, except
// DELETE (which cannot be filtered; see lib/realtime/scoped-changes.ts).
//
// Reads the source, so it catches the careless case: a new subscription added
// without a filter fails here until it is scoped (use onScopedChanges).
// ============================================================

const SRC = path.join(process.cwd(), "src");

function* files(dir: string): Generator<string> {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* files(full);
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name)) yield full;
  }
}

interface Subscription {
  file: string;
  table: string;
  event: string | null;
  filtered: boolean;
}

/** The `{ ... }` object literal enclosing `index`, balanced so template-literal `${}` braces are fine. */
function enclosingObject(text: string, index: number): string | null {
  let depth = 0;
  let start = -1;
  for (let i = index; i >= 0; i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{") {
      if (depth === 0) {
        start = i;
        break;
      }
      depth--;
    }
  }
  return start < 0 ? null : balancedFrom(text, start);
}

function balancedFrom(text: string, start: number): string | null {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/** Raw `postgres_changes` configs (schema: "public") and onScopedChanges specs (always filtered). */
function subscriptions(): Subscription[] {
  const out: Subscription[] = [];
  for (const file of files(SRC)) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("postgres_changes") && !text.includes("onScopedChanges")) continue;
    const rel = path.relative(process.cwd(), file).split(path.sep).join("/");
    const add = (body: string, scoped: boolean) => {
      const table = body.match(/table:\s*["']([\w]+)["']/)?.[1];
      if (!table) return;
      out.push({
        file: rel,
        table,
        event: body.match(/event:\s*["'](\*|INSERT|UPDATE|DELETE)["']/)?.[1] ?? null,
        filtered: scoped || /filter\s*[:,}]/.test(body),
      });
    };
    for (const m of text.matchAll(/schema:\s*["']public["']/g)) {
      const body = enclosingObject(text, m.index!);
      if (body) add(body, false);
    }
    for (const m of text.matchAll(/onScopedChanges\(\s*\w+,\s*(\{)/g)) {
      const body = balancedFrom(text, m.index! + m[0].length - 1);
      if (body && !file.endsWith("scoped-changes.ts")) add(body, true);
    }
  }
  return out;
}

describe("realtime subscriptions", () => {
  const subs = subscriptions();

  it("finds the subscriptions (guards against the scan silently matching nothing)", () => {
    expect(subs.length).toBeGreaterThan(15);
  });

  it("every one is filtered, except deletes", () => {
    const open = subs
      .filter((s) => !s.filtered && s.event !== "DELETE")
      .map((s) => `${s.file}: ${s.table} (${s.event ?? "no event"})`);
    expect(open, "Unfiltered subscriptions. Add a filter (account_id=eq... or a row id), or use onScopedChanges:").toEqual([]);
  });

  it("no subscription filters a DELETE, which would silence it", () => {
    const bad = subs.filter((s) => s.filtered && s.event === "DELETE").map((s) => `${s.file}: ${s.table}`);
    expect(bad).toEqual([]);
  });

  it("messages are subscribed by workspace, never unfiltered", () => {
    const messages = subs.filter((s) => s.table === "messages");
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.filter((s) => !s.filtered && s.event !== "DELETE")).toEqual([]);
  });
});
