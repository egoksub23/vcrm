import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider, createTranslator } from "next-intl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Render tests for KYC review in every language, with the real wording from messages/<locale>.json. next-intl is told to throw on a missing key or
// argument instead of printing a raw key path. renderToStaticMarkup paints the FIRST render only (effects, timers, fetches and event handlers do not run),
// so what is checked here is what each state looks like: the list, the masked and revealed data card, the notices, the error words, the image viewer's
// phases (loading, ready with its watermark and tools, covered, error), the access log table and the screen's first paint.
// NOT covered (no DOM renderer): clicking, typing, focus movement, the idle and reveal timers, blob URLs, the real fetches. See docs/kyc-review.md.

vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => ({ user: { id: "u1", email: "reviewer@example.test" }, profile: { full_name: "Reviewer One", email: "reviewer@example.test" }, capabilities: new Set(["menu.kyc"]), refreshCapabilities: () => undefined }),
  useCapability: () => true,
}));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));

import type { KycAccessRow, KycValidation } from "@/lib/kyc/types";

import { AccessLogPanel, AccessLogTable } from "./access-log";
import { INITIAL_VIEW, watermarkBackground, watermarkText } from "./helpers";
import { ImageViewerView, type Phase } from "./image-viewer";
import { KycScreen } from "./kyc-screen";
import { DataCard, ErrorPanel, ProvisionalNote, ReadOnlyNotice, SetupNotice, StatusChip, UatBanner, ValidationList } from "./parts";

const LOCALES = ["en", "ms", "zh", "ko"] as const;
type Locale = (typeof LOCALES)[number];
type Tree = Record<string, unknown>;

const catalogue = (locale: string): Tree => JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")) as Tree;
const CATALOGUES = Object.fromEntries(LOCALES.map((l) => [l, catalogue(l)])) as Record<Locale, Tree>;
const kyc = (locale: Locale) => CATALOGUES[locale].Kyc as Tree & { readOnlyNotice: string; tabs: { review: string; log: string }; status: Record<string, string>; detail: Record<string, string> & { fields: Record<string, string> }; image: Record<string, string>; log: Record<string, string> & { columns: Record<string, string> }; setup: Record<string, string>; list: Record<string, string>; errors: Record<string, string>; search: Record<string, string>; title: string; recordedFooter: string };

const translatorFor = (locale: Locale, namespace: string) =>
  createTranslator({ locale, messages: CATALOGUES[locale] as never, namespace: namespace as never }) as unknown as (key: string, values?: Record<string, unknown>) => string;

let errors: unknown[][] = [];
beforeEach(() => {
  errors = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void errors.push(args));
});
afterEach(() => {
  vi.restoreAllMocks();
});

function page(locale: Locale, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={CATALOGUES[locale] as never}
      onError={(e) => {
        throw e;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ");

const NOW = Date.parse("2026-10-12T12:00:00Z");
const v = (over: Partial<KycValidation> = {}): KycValidation => ({
  id: "val_123",
  idUsable: true,
  friendId: "child-77",
  type: "NRIC",
  status: { raw: "verified", tone: "positive" },
  createdAt: "2026-10-12T11:55:00.000Z",
  createdAtRaw: "2026-10-12T11:55:00Z",
  updatedAt: null,
  score: "93%",
  reason: null,
  known: [
    { key: "name", label: "Name", value: "Aisyah binti Ali", sensitive: false, masked: false },
    { key: "idNumber", label: "ID number", value: "15••••••34", sensitive: true, masked: true },
    { key: "dob", label: "Date of birth", value: null, sensitive: true, masked: true },
    { key: "address", label: "Address", value: null, sensitive: true, masked: true },
  ],
  extra: [{ key: "extracted.expiry", label: null, value: "2030-01-01", sensitive: false, masked: false }],
  withheld: 2,
  fallback: false,
  hasMasked: true,
  ...over,
});
const REVEALED = v({
  known: [
    { key: "name", label: "Name", value: "Aisyah binti Ali", sensitive: false, masked: false },
    { key: "idNumber", label: "ID number", value: "150304101234", sensitive: true, masked: false },
    { key: "dob", label: "Date of birth", value: "2015-03-04", sensitive: true, masked: false },
    { key: "address", label: "Address", value: "12 Jalan Mawar", sensitive: true, masked: false },
  ],
  hasMasked: false,
});

describe.each(LOCALES)("KYC review in %s", (locale) => {
  const m = kyc(locale);

  it("shows the read-only notice, the UAT banner and (for admins) the provisional-names note", () => {
    const html = page(locale, (
      <>
        <ReadOnlyNotice />
        <UatBanner />
        <ProvisionalNote />
      </>
    ));
    expect(text(html)).toContain(m.readOnlyNotice);
    expect(text(html)).toContain((m as unknown as { uatBanner: string }).uatBanner);
    expect(text(html)).toContain((m as unknown as { provisionalNote: string }).provisionalNote);
    expect(html).toContain('role="note"');
  });

  it("says 'not set up': an administrator sees the variable names, everyone else is told to ask one", () => {
    const admin = page(locale, <SetupNotice status={{ missing: ["KYC_DOC_API_BASE_URL", "KYC_DOC_API_KEY"], isAdmin: true }} />);
    expect(admin).toContain("KYC_DOC_API_BASE_URL");
    expect(admin).toContain("KYC_DOC_API_KEY");
    expect(text(admin)).toContain(m.setup.adminBody);
    const other = page(locale, <SetupNotice status={{ missing: [], isAdmin: false }} />);
    expect(other).not.toContain("KYC_DOC_API_KEY");
    expect(text(other)).toContain(m.setup.othersBody);
  });

  it("words every error and gives administrators the extra hint for a rejected key and a blocked image host", () => {
    for (const code of Object.keys(m.errors).filter((k) => !["unauthorizedAdmin", "imageHostAdmin"].includes(k))) {
      const html = page(locale, <ErrorPanel code={code} isAdmin={false} onRetry={() => undefined} />);
      expect(text(html), code).toContain(m.errors[code]);
      expect(html).toContain('role="alert"');
      expect(text(html)).toContain((m as unknown as { retry: string }).retry);
    }
    expect(text(page(locale, <ErrorPanel code="upstream_unauthorized" isAdmin />))).toContain(m.errors.unauthorizedAdmin);
    expect(text(page(locale, <ErrorPanel code="upstream_unauthorized" isAdmin={false} />))).not.toContain(m.errors.unauthorizedAdmin);
    expect(text(page(locale, <ErrorPanel code="image_host_blocked" isAdmin />))).toContain(m.errors.imageHostAdmin);
    expect(text(page(locale, <ErrorPanel code="unknown_code_xyz" isAdmin={false} />))).toContain(m.errors.generic);
  });

  it("marks a status with a word and an icon, never colour alone", () => {
    for (const tone of ["positive", "pending", "negative", "neutral"] as const) {
      const html = page(locale, <StatusChip status={{ raw: tone === "neutral" ? "escalated" : tone, tone }} />);
      expect(html).toContain(`data-tone="${tone}"`);
      expect(html).toContain("<svg");
      expect(html).toContain('class="sr-only"');
      expect(text(html)).toContain(m.status[tone]);
      expect(text(html)).toContain(tone === "neutral" ? "escalated" : tone);
    }
    expect(text(page(locale, <StatusChip status={{ raw: null, tone: "neutral" }} />))).toContain(m.status.unknown);
  });

  it("lists the validations: type and status chips, a relative time with the exact time in its tooltip, a short id and the score", () => {
    const items = [
      v({ id: "val_124_with_a_long_identifier", status: { raw: "pending", tone: "pending" }, createdAt: "2026-10-12T09:00:00.000Z", score: null }),
      v(),
      v({ id: "", idUsable: false, type: null, createdAt: null, createdAtRaw: null, status: { raw: null, tone: "neutral" }, score: null }),
    ];
    const html = page(locale, <ValidationList items={items} selectedKey="val_123" onSelect={() => undefined} now={NOW} />);
    expect(html).toContain("<time");
    expect(html).toMatch(/<time[^>]*title="[^"]+"/);
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("NRIC");
    expect(html).toContain("val_124_…fier");
    expect(text(html)).toContain(m.list.score.replace("{score}", "93%"));
    expect(text(html)).toContain(m.list.typeUnknown);
    expect(text(html)).toContain(m.list.noTime);
    expect(text(html)).toContain(m.list.noId);
    expect(html.match(/<button/g)).toHaveLength(3);
  });

  it("shows masked values as 'Hidden' or a partly masked string with a lock, and offers Reveal only to a person who may", () => {
    const masked = page(locale, <DataCard v={v()} canReveal revealed={false} revealing={false} onReveal={() => undefined} onHide={() => undefined} now={NOW} />);
    const t = text(masked);
    expect(t).toContain(m.detail.fields.idNumber);
    expect(masked).toContain("15••••••34");
    expect(t).toContain(m.detail.hidden);
    expect(masked).toContain("<svg");
    expect(masked).toContain(`>${m.detail.reveal}<`);
    for (const secret of ["150304101234", "2015-03-04", "Jalan Mawar"]) expect(masked).not.toContain(secret);
    // the generic list and the technical details
    expect(masked).toContain("extracted.expiry");
    expect(masked).toContain("<details");
    expect(t).toContain(m.detail.technical);
    expect(t).toContain(translatorFor(locale, "Kyc.detail")("withheld", { count: 2 }));

    const noPermission = page(locale, <DataCard v={v()} canReveal={false} revealed={false} revealing={false} onReveal={() => undefined} onHide={() => undefined} now={NOW} />);
    expect(noPermission).not.toContain(`>${m.detail.reveal}<`);
    expect(text(noPermission)).toContain(m.detail.noRevealPermission);
    for (const secret of ["150304101234", "2015-03-04"]) expect(noPermission).not.toContain(secret);
  });

  it("shows the revealed values with the two-minute note and 'Hide again'", () => {
    const html = page(locale, <DataCard v={REVEALED} canReveal revealed revealing={false} onReveal={() => undefined} onHide={() => undefined} now={NOW} />);
    const t = text(html);
    expect(t).toContain("150304101234");
    expect(t).toContain("2015-03-04");
    expect(t).toContain(m.detail.revealNote);
    expect(t).toContain(m.detail.hideAgain);
    expect(html).not.toContain(`>${m.detail.reveal}<`);
  });

  it("disables Reveal while it works and when the validation has no usable id", () => {
    const working = page(locale, <DataCard v={v()} canReveal revealed={false} revealing onReveal={() => undefined} onHide={() => undefined} now={NOW} />);
    expect(working).toMatch(/<button[^>]*disabled[^>]*>[^<]*(<[^>]+>)*[^<]*/);
    expect(text(working)).toContain(m.detail.revealing);
    const noId = page(locale, <DataCard v={v({ id: "", idUsable: false })} canReveal revealed={false} revealing={false} onReveal={() => undefined} onHide={() => undefined} now={NOW} />);
    expect(noId).toContain("disabled");
  });

  it("draws each phase of the image viewer", () => {
    const wm = watermarkBackground(watermarkText("Reviewer One", new Date("2026-10-12T03:04:05Z"), locale));
    const view = (phase: Phase, isAdmin = false) => page(locale, <ImageViewerView phase={phase} view={INITIAL_VIEW} onView={() => undefined} watermark={wm} isAdmin={isAdmin} onRetry={() => undefined} onShow={() => undefined} onActivity={() => undefined} />);

    const loading = view({ kind: "loading" });
    expect(loading).toContain('data-testid="kyc-image-skeleton"');
    expect(loading).toContain("animate-pulse");
    expect(text(loading)).toContain(m.image.loading);
    expect(loading).not.toContain("<img");

    const ready = view({ kind: "ready", url: "blob:https://halo.test/abc" });
    expect(ready).toContain('src="blob:https://halo.test/abc"');
    expect(ready).toContain('draggable="false"');
    expect(ready).toContain('data-testid="kyc-watermark"');
    expect(ready).toContain("pointer-events-none");
    expect(ready).toContain("background-image");
    expect(ready).toContain('role="toolbar"');
    expect(ready).toContain('role="group"');
    expect(ready).toContain('tabindex="0"');
    expect(ready).toContain(`aria-label="${m.image.zoomIn}"`);
    expect(ready).toContain(`aria-label="${m.image.rotate}"`);
    expect(text(ready)).toContain(m.image.watermarkNote);
    // no download control and no link to the file
    expect(ready).not.toContain("download");
    expect(ready).not.toMatch(/<a\s/);

    const covered = view({ kind: "covered" });
    expect(text(covered)).toContain(m.image.covered);
    expect(text(covered)).toContain(m.image.show);
    expect(covered).not.toContain("<img");
    expect(covered).not.toContain("blob:");

    const failed = view({ kind: "error", code: "image_host_blocked" }, true);
    expect(failed).toContain('role="alert"');
    expect(text(failed)).toContain(m.errors.image_host_blocked);
    expect(text(failed)).toContain(m.errors.imageHostAdmin);
    expect(text(failed)).toContain((m as unknown as { retry: string }).retry);
  });

  it("lists the access log with names, words for the actions and outcomes, and a former member", () => {
    const rows: KycAccessRow[] = [
      { id: "1", createdAt: "2026-10-12T11:00:00.000Z", userId: "u1", userName: "Reviewer One", action: "view_image", friendId: "child-77", validationId: "val_123", outcome: "ok" },
      { id: "2", createdAt: "2026-10-12T10:00:00.000Z", userId: "gone", userName: null, action: "reveal", friendId: "child-77", validationId: "val_123", outcome: "forbidden" },
      { id: "3", createdAt: "2026-10-12T09:00:00.000Z", userId: "u1", userName: "Reviewer One", action: "config_error", friendId: null, validationId: null, outcome: "error" },
    ];
    const html = page(locale, <AccessLogTable rows={rows} />);
    const t = text(html);
    for (const col of Object.values(m.log.columns)) expect(t).toContain(col);
    const actions = (m.log as unknown as { actions: Record<string, string>; outcomes: Record<string, string> });
    for (const k of ["view_image", "reveal", "config_error"]) expect(t).toContain(actions.actions[k]);
    for (const k of ["ok", "forbidden", "error"]) expect(t).toContain(actions.outcomes[k]);
    expect(t).toContain("Reviewer One");
    expect(t).toContain(m.log.formerMember);
    expect(html).toContain('scope="col"');
    expect(html).toContain("<time");
    expect(html).toContain("child-77");
  });

  it("paints the access log tab's filters and export link on first render", () => {
    const html = page(locale, <AccessLogPanel />);
    const t = text(html);
    for (const k of ["person", "friendId", "action", "from", "to", "apply", "export", "exportNote"]) expect(t, k).toContain(m.log[k]);
    expect(html).toContain('type="date"');
    expect(html).toContain("/api/kyc/access-log/export");
    expect(html).toContain("download");
    expect(html.match(/<label/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it("paints the screen's first render: heading, the read-only notice and the 'recorded' footer, nothing else before the status arrives", () => {
    const html = page(locale, <KycScreen />);
    const t = text(html);
    expect(t).toContain(m.title);
    expect(t).toContain(m.readOnlyNotice);
    expect(t).toContain(m.recordedFooter);
    expect(html).toContain("<h1");
    expect(html).not.toContain("role=\"tablist\"");
    expect(html).not.toContain("<form");
    expect(errors).toEqual([]);
  });
});

describe("the wording is complete and consistent across languages", () => {
  const leaves = (node: unknown, prefix = ""): string[] =>
    node && typeof node === "object" ? Object.entries(node as Tree).flatMap(([k, val]) => leaves(val, prefix ? `${prefix}.${k}` : k)) : [prefix];
  it("has the same keys in every language, none empty", () => {
    const en = leaves(CATALOGUES.en.Kyc).sort();
    expect(en.length).toBeGreaterThan(100);
    for (const l of LOCALES) expect(leaves(CATALOGUES[l].Kyc).sort(), l).toEqual(en);
    const flat = (n: unknown, p = ""): [string, string][] => (n && typeof n === "object" ? Object.entries(n as Tree).flatMap(([k, x]) => flat(x, p ? `${p}.${k}` : k)) : [[p, String(n)]]);
    for (const l of LOCALES) for (const [k, val] of flat(CATALOGUES[l].Kyc)) expect(val.trim().length, `${l} ${k}`).toBeGreaterThan(0);
  });
  it("names the capabilities, the group, the sidebar row and the operator switch in every language", () => {
    for (const l of LOCALES) {
      const c = CATALOGUES[l] as Tree & { Permissions: { cap: Record<string, { label: string; description: string }>; group: Record<string, string> }; Sidebar: Record<string, string>; Header: Record<string, string>; Platform: Record<string, string> };
      for (const id of ["menu_kyc", "kyc_view", "kyc_reveal"]) {
        expect(c.Permissions.cap[id].label.length, `${l} ${id}`).toBeGreaterThan(0);
        expect(c.Permissions.cap[id].description.length, `${l} ${id}`).toBeGreaterThan(20);
      }
      expect(c.Permissions.group.kyc.length).toBeGreaterThan(0);
      expect(c.Sidebar.kyc.length).toBeGreaterThan(0);
      expect(c.Header.kyc.length).toBeGreaterThan(0);
      expect(c.Platform.feature_kyc.length).toBeGreaterThan(0);
      expect(c.Platform.feature_kyc_desc.length).toBeGreaterThan(20);
    }
  });
});

describe("source rules for the KYC screens", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  const root = process.cwd();
  const ui = files(join(root, "src", "components", "kyc")).filter((f) => /\.tsx?$/.test(f) && !/\.test\./.test(f));
  const read = (f: string) => readFileSync(f, "utf8");

  it("uses no Tailwind dark: variants (they do not work in this app); colours are tokens or light-dark() pairs", () => {
    for (const f of ui) expect(read(f), f).not.toMatch(/(^|[\s"'`])dark:/);
  });

  it("imports no Node-only module into a client component", () => {
    for (const f of ui) expect(read(f), f).not.toMatch(/from ["']node:|from ["'](fs|path|crypto|net|dns|child_process)["']/);
    for (const f of ui) expect(read(f), f).not.toMatch(/@\/lib\/kyc\/(config|client|service|audit|runtime|http|ssrf)["']/);
  });

  it("never mentions the key, the base URL or an environment read in the browser code", () => {
    for (const f of ui) {
      const src = read(f);
      expect(src, f).not.toMatch(/process\.env/);
      expect(src, f).not.toMatch(/NEXT_PUBLIC_KYC/);
      expect(src, f).not.toMatch(/x-api-key/i);
      expect(src, f).not.toMatch(/apis-uat|verify_doc/);
    }
  });

  it("keeps the secrets' names out of every NEXT_PUBLIC variable, anywhere in src", () => {
    for (const f of files(join(root, "src")).filter((p) => /\.tsx?$/.test(p) && !/\.test\./.test(p))) {
      expect(read(f), f).not.toMatch(/NEXT_PUBLIC_KYC|NEXT_PUBLIC_[A-Z_]*DOC_API/);
    }
  });

  it("reads the key and the base URL only in the server's configuration module (and passes process.env to it in the runtime)", () => {
    const users = files(join(root, "src")).filter((p) => /\.tsx?$/.test(p) && !/\.test\./.test(p) && !/test-support/.test(p) && /KYC_DOC_API_KEY|KYC_DOC_API_BASE_URL/.test(read(p))).map((p) => p.slice(root.length + 1).replace(/\\/g, "/"));
    // config.ts names them; the screen's setup notice only prints the NAMES of the missing variables (never a value)
    expect(users.sort()).toEqual(["src/components/kyc/parts.tsx", "src/lib/kyc/config.ts"]);
  });
});
