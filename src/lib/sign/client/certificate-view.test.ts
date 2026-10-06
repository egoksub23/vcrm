import { readFileSync } from "node:fs";
import { join } from "node:path";

import { createTranslator } from "next-intl";
import { describe, expect, it } from "vitest";

import { CERTIFICATE_ERROR_CODES, CERTIFICATE_WARNING_CODES, certificateErrorKey, certificateKind, groupFingerprint, shortSerial } from "./certificate-view";

describe("certificateKind", () => {
  it("tells where a certificate comes from, which is what a PDF reader goes by", () => {
    expect(certificateKind({ uploaded: false, selfSigned: true })).toBe("generated");
    expect(certificateKind({ uploaded: true, selfSigned: true })).toBe("uploadedSelfSigned");
    expect(certificateKind({ uploaded: true, selfSigned: false })).toBe("authority");
  });
});

describe("shortSerial and groupFingerprint", () => {
  it("cuts a long serial to its last 16 digits and marks the cut", () => {
    expect(shortSerial("4F2A")).toBe("4F2A");
    expect(shortSerial("0123456789abcdef0123456789abcdef")).toBe("…0123456789ABCDEF");
    expect(shortSerial(null)).toBeNull();
    expect(shortSerial("")).toBeNull();
  });

  it("prints a fingerprint in pairs of capitals", () => {
    expect(groupFingerprint("ab01cd")).toBe("AB:01:CD");
    expect(groupFingerprint(undefined)).toBeNull();
  });
});

describe("certificateErrorKey", () => {
  it("words the codes the certificate routes answer with, and leaves the rest to the general sentence", () => {
    expect(certificateErrorKey("p12_bad_passphrase")).toBe("errors.p12_bad_passphrase");
    expect(certificateErrorKey("rate_limited")).toBeNull();
    expect(certificateErrorKey(null)).toBeNull();
    expect(CERTIFICATE_ERROR_CODES.every((c) => certificateErrorKey(c) === `errors.${c}`)).toBe(true);
  });
});

// ---- the words ------------------------------------------------------------------------------------------------
// Doc Sign's own keys are merged into messages/*.json from fragments. Until that has happened (or when the files are
// somewhere else, SIGN_MESSAGES_DIR) there is nothing to hold to the code, so this part is skipped.

const dir = process.env.SIGN_MESSAGES_DIR ?? join(process.cwd(), "messages");
const LOCALES = ["en", "ms", "zh", "ko"] as const;

function read(locale: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(join(dir, `${locale}.json`), "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const all = Object.fromEntries(LOCALES.map((l) => [l, read(l)])) as Record<(typeof LOCALES)[number], Record<string, unknown> | null>;
const merged = LOCALES.every((l) => ((all[l]?.Sign as { admin?: { certificate?: { uploadTitle?: string } } } | undefined)?.admin?.certificate?.uploadTitle ? true : false));
const words = merged ? describe : describe.skip;

function at(locale: (typeof LOCALES)[number], path: string): unknown {
  return path.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), all[locale]);
}

// the names of the values a message takes: a word right after "{" and before "," or "}" (not a word that starts a plural branch)
const placeholders = (s: string) => [...new Set([...s.matchAll(/\{(\w+)\s*[,}]/g)].map((m) => m[1]))].sort();

const CERT = "Sign.admin.certificate";
const certificateKeys = [
  "intro", "loading", "retry", "none", "stateValid", "stateExpiring", "stateExpired", "subject", "issuer", "kind", "serial", "validFrom", "validUntil", "daysLeft", "daysLeftValue", "fingerprint", "key", "keyValue", "chain", "chainOne", "chainMany",
  "unknown", "unreadableTitle", "unreadableBody", "expiredTitle", "expiredBody", "expiredBodyUploaded", "readersTitle", "uploadTitle", "uploadIntro", "fileLabel", "fileHint", "passphraseLabel", "passphraseHint", "nameLabel", "nameHint",
  "install", "installing", "installed", "removed", "remove", "removeConfirm", "removeYes", "removeNo", "footnote",
  ...(["generated", "uploadedSelfSigned", "authority"] as const).flatMap((k) => [`kind_${k}`, `readers_${k}`]),
  ...CERTIFICATE_WARNING_CODES.flatMap((w) => [`warn_${w}_title`, `warn_${w}_body`]),
  ...CERTIFICATE_ERROR_CODES.map((c) => `errors.${c}`),
].map((k) => `${CERT}.${k}`);
const retentionKeys = [
  ...["retention", "retentionTitle", "retentionIntro", "retentionHint", "retentionEffect", "retentionPast", "retentionPastNone", "errors.retention"].map((k) => `Sign.admin.general.${k}`),
  "Sign.admin.categories.retentionHint",
  "Sign.detail.banner.retainedUntil",
  "Sign.detail.banner.retentionEnded",
];

words("the words of the certificate and retention screens", () => {
  it("has every key, in all four languages, with the same placeholders", () => {
    for (const key of [...certificateKeys, ...retentionKeys]) {
      const en = at("en", key);
      expect(typeof en, `en ${key}`).toBe("string");
      for (const l of LOCALES) {
        const text = at(l, key);
        expect(typeof text, `${l} ${key}`).toBe("string");
        expect((text as string).trim().length, `${l} ${key} is empty`).toBeGreaterThan(0);
        expect(placeholders(text as string), `${l} ${key} placeholders`).toEqual(placeholders(en as string));
      }
    }
  });

  it("formats every message with real values (no broken ICU) and never answers with the key", () => {
    for (const l of LOCALES) {
      const t = createTranslator({ locale: l, messages: all[l] as never }) as unknown as (k: string, v?: Record<string, unknown>) => string;
      for (const key of [...certificateKeys, ...retentionKeys]) {
        const out = t(key, { count: 3, bits: 2048, date: "6 Oct 2026" });
        expect(out, `${l} ${key}`).not.toContain(key);
        expect(out.length).toBeGreaterThan(0);
      }
    }
  });

  it("uses only keys that exist where the certificate screens ask for a literal one", () => {
    const known = new Set(certificateKeys.map((k) => k.slice(CERT.length + 1)));
    for (const file of ["certificate-section.tsx", "certificate-facts.tsx"]) {
      const source = readFileSync(join(process.cwd(), "src", "components", "settings", "sign", file), "utf8");
      // a failure is also worded through the shared admin errors (errorText), which is another namespace
      for (const m of source.matchAll(/\bt\(\s*"([^"$]+)"/g)) expect(known.has(m[1]), `${file} asks for t("${m[1]}")`).toBe(true);
    }
  });
});
