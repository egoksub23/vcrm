import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// The PDF engine reads its fonts from disk at run time (src/lib/sign/pdf/assets), and Next's standalone build only copies the files a route can be
// seen to import, so the fonts are listed for the routes by `outputFileTracingIncludes` in next.config.ts. A route that seals, stamps or checks a
// signed file and is NOT listed would run in the image with no fonts and fail with ENOENT, and a document would sit in "finishing". This guards both
// halves: the config lists the fonts for every route under /api/sign and /api/v1/sign, and no route outside them can reach the engine.

const root = process.cwd();
const config = readFileSync(join(root, "next.config.ts"), "utf8");

function routes(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...routes(full));
    else if (/^route\.ts$/.test(name)) out.push(full);
  }
  return out;
}
const routePath = (file: string) => "/" + relative(join(root, "src", "app"), file).split(sep).slice(0, -1).join("/");

/** Modules that, directly, make a route run the PDF engine (stamp, seal, certificate pages, fit check). */
const ENGINE = /@\/lib\/sign\/(pdf(\/|")|service\/(seal|seal-after|seal-retry|jobs|signing|envelope-signing|send|envelopes|drafts|templates|bulk|registration|replace-file)")/;

describe("the fonts reach the routes that need them", () => {
  it("lists the fonts for every route under /api/sign and /api/v1/sign", () => {
    expect(config).toMatch(/"\/api\/sign\/\*\*\/\*":\s*\[[^\]]*"\.\/src\/lib\/sign\/pdf\/assets\/\*\*\/\*"/);
    expect(config).toMatch(/"\/api\/v1\/sign\/\*\*\/\*":\s*\[[^\]]*"\.\/src\/lib\/sign\/pdf\/assets\/\*\*\/\*"/);
  });

  it("has no route outside those two that imports a module which runs the engine (the jobs, the finish routes and the retry routes are all under /api/sign)", () => {
    const outside: string[] = [];
    for (const file of routes(join(root, "src", "app"))) {
      const path = routePath(file);
      if (path.startsWith("/api/sign/") || path.startsWith("/api/v1/sign/")) continue;
      if (ENGINE.test(readFileSync(file, "utf8"))) outside.push(path);
    }
    expect(outside).toEqual([]);
  });

  it("keeps the sealing routes where the fonts are: the minute job, both finish routes and both retry routes", () => {
    for (const path of ["/api/sign/jobs-cron", "/api/sign/public/[token]/complete", "/api/sign/public/[token]/envelope/finish", "/api/sign/documents/[id]/retry-seal", "/api/sign/envelopes/[id]/retry-seal"]) {
      const file = join(root, "src", "app", ...path.split("/").filter(Boolean), "route.ts");
      expect(statSync(file).isFile(), path).toBe(true);
    }
  });
});

describe("the image carries the fonts whatever route runs the engine", () => {
  it("copies the fonts and the add-on files into the runtime image whole (an automation sends documents from routes that are not under /api/sign)", () => {
    const docker = readFileSync(join(root, "Dockerfile"), "utf8");
    expect(docker).toContain("/app/src/lib/sign/pdf/assets ./src/lib/sign/pdf/assets");
    expect(docker).toContain("/app/src/lib/sign/addons ./src/lib/sign/addons");
    // the engine looks for them under the working directory of the server
    expect(readFileSync(join(root, "src", "lib", "sign", "pdf", "fonts.ts"), "utf8")).toContain('path.join(process.cwd(), "src", "lib", "sign", "pdf", "assets")');
  });
});
