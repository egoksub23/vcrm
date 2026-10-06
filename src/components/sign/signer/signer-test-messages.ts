// Doc Sign, signing page: the messages, for tests. The `Sign.signer` subtree of messages/<locale>.json.

import { readFileSync } from "node:fs";
import { join } from "node:path";

type Tree = { [key: string]: unknown };

export const SIGNER_LOCALES = ["en", "ms", "zh", "ko"] as const;

function subtree(catalogue: unknown): Tree | null {
  const sign = (catalogue as Tree | null)?.Sign as Tree | undefined;
  const signer = sign?.signer;
  return signer && typeof signer === "object" ? (signer as Tree) : null;
}

/** The page's messages per language, or null when they are not in the message files. */
export function readSignerMessages(): Record<(typeof SIGNER_LOCALES)[number], Tree> | null {
  const merged: Partial<Record<(typeof SIGNER_LOCALES)[number], Tree>> = {};
  for (const locale of SIGNER_LOCALES) {
    try {
      const own = subtree(JSON.parse(readFileSync(join(process.cwd(), "messages", `${locale}.json`), "utf8")));
      if (own) merged[locale] = own;
    } catch {
      // not there
    }
  }
  if (SIGNER_LOCALES.every((l) => merged[l])) return merged as Record<(typeof SIGNER_LOCALES)[number], Tree>;
  return null;
}
