import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";

// A Halo user on the people list is named as one ("you" for the signed-in person), and the "your turn" words exist in
// every language. Words come from the merged message files; until the fragments of work package 15 are merged, set
// SIGN_I18N_FRAGMENTS to the folder that holds detail-wp15.json.

vi.mock("@/lib/supabase/client", () => {
  const stub: unknown = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  return { createClient: () => stub };
});
vi.mock("@/hooks/use-can", () => ({ useCapability: () => true }));
vi.mock("@/hooks/use-auth", () => ({ useAuth: () => ({ user: { id: "u-me" } }) }));
vi.mock("next/link", () => ({ default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => React.createElement("a", { href, ...rest }, children) }));

import type { SignDocumentRow, SignSignerRow } from "@/lib/sign/types";
import { PeopleList } from "./people-list";

type Tree = Record<string, unknown>;

function merge(a: Tree, b: Tree): Tree {
  const out: Tree = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === "object" && !Array.isArray(v) && typeof a[k] === "object" ? merge(a[k] as Tree, v as Tree) : v;
  return out;
}

function wording(locale: string): Tree | null {
  const file = join(process.cwd(), "messages", `${locale}.json`);
  const merged = existsSync(file) ? ((JSON.parse(readFileSync(file, "utf8")) as { Sign?: { detail?: Tree } }).Sign?.detail ?? null) : null;
  if (!merged) return null;
  if ((merged.people as Tree | undefined)?.haloUser) return merged;
  const dir = process.env.SIGN_I18N_FRAGMENTS;
  const fragment = dir && existsSync(join(dir, "detail-wp15.json")) ? (JSON.parse(readFileSync(join(dir, "detail-wp15.json"), "utf8")) as Record<string, Tree>)[locale] : null;
  return fragment ? merge(merged, fragment) : null;
}
const LOCALES = ["en", "ms", "zh", "ko"].filter((l) => wording(l) !== null);

const STATUS = {
  document: { draft: "Draft", sent: "Sent", in_progress: "In progress", sealing: "Sealing", completed: "Completed", declined: "Declined", expired: "Expired", voided: "Cancelled", failed: "Failed" },
  signer: { pending: "Pending", sent: "Invited", viewed: "Opened", signed: "Signed", declined: "Declined", filled: "Filled in" },
  unknown: "Unknown",
};

const doc = {
  id: "d1", account_id: "a1", reference: "SGN-1", title: "Agreement", status: "in_progress", sign_in_order: false, code_required: true, locale: "en",
  roles_snapshot: [{ key: "director", label: "Director", kind: "signer", color: 1 }, { key: "merchant", label: "Merchant", kind: "signer", color: 0 }],
  allow_forwarding: false, form_snapshot: null, expires_at: "2026-10-20T00:00:00Z",
} as unknown as SignDocumentRow;

const signer = (over: Partial<SignSignerRow>) =>
  ({ id: "s1", account_id: "a1", document_id: "d1", role_key: "director", kind: "signer", full_name: "Gokula", email: "g@vircle.example", phone: null, channel: "email", order_no: 1, status: "sent", internal_user_id: null, invited_at: "2026-10-06T09:10:00Z", viewed_at: null, signed_at: null, declined_at: null, decline_reason: null, last_reminded_at: null, reminder_count: 0, part_keys: null, delegated_by: null, forward_count: 0, forward_history: [], created_at: "2026-10-06T09:04:00Z", updated_at: "2026-10-06T09:10:00Z", ...over }) as SignSignerRow;

describe.skipIf(LOCALES.length === 0)("a Halo user on the people list", () => {
  for (const locale of LOCALES) {
    it(`is named as one, and as 'you' for the signed-in person (${locale})`, () => {
      const detail = wording(locale)!;
      const t = (path: string) => path.split(".").reduce<unknown>((n, k) => (n as Tree)[k], detail) as string;
      const html = renderToStaticMarkup(
        <NextIntlClientProvider locale={locale} timeZone="UTC" messages={{ Sign: { detail, send: { status: STATUS } } }} onError={(e) => { throw e; }}>
          <PeopleList
            document={doc}
            signers={[signer({}), signer({ id: "s2", full_name: "Siti", internal_user_id: "u-other", role_key: "merchant", order_no: 2 }), signer({ id: "s3", full_name: "Ali", internal_user_id: "u-me", role_key: "merchant", order_no: 3 }), signer({ id: "s4", full_name: "Outside", email: "o@example.com", order_no: 4 })]}
            undelivered={new Set()}
            caps={{ send: true, void: true, reveal: true, settings: true }}
            onChanged={async () => {}}
          />
        </NextIntlClientProvider>,
      );
      // two Halo users (one of them the viewer) and two outside signers without the label; the viewer's label contains the plain one
      expect(html.split(t("people.haloUserYou")).length - 1).toBe(1);
      expect(html.split(t("people.haloUser")).length - 1).toBe(2);
    });

    it(`has the words of the 'your turn' panel and the two history lines (${locale})`, () => {
      const detail = wording(locale)!;
      const get = (path: string) => path.split(".").reduce<unknown>((n, k) => (n as Tree | undefined)?.[k], detail);
      for (const key of ["yourTurn.title", "yourTurn.body", "events.halo_link", "events.code_verified_halo"]) expect(get(key), `${locale}.${key}`).toEqual(expect.any(String));
      expect(get("events.halo_link")).toContain("{actor}");
      expect(get("events.code_verified_halo")).toContain("{actor}");
    });
  }
});
