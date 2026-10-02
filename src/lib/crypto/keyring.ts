// ============================================================
// Encryption key ring.
//
// Stored secrets (WhatsApp / Gmail / Microsoft / Meta / Jira tokens, AI keys,
// webhook secrets) are encrypted with AES-256-GCM. Until now there was exactly
// one key, `ENCRYPTION_KEY`, so it could never be changed without making every
// stored token unreadable. The ring lets several keys be loaded at once so a key
// can be rotated and a leaked one retired.
//
//   ENCRYPTION_KEY       the original key (64 hex chars). Always readable.
//                        Unversioned ciphertexts were written with it.
//   ENCRYPTION_KEYS      extra keys, `id:hex,id:hex`. Ids are 1-32 characters
//                        from A-Z a-z 0-9 _ - (no colon, no dot).
//   ENCRYPTION_KEY_ID    the id new ciphertexts are written with. When unset,
//                        nothing changes: writes keep the original format under
//                        ENCRYPTION_KEY, so an older build can still read them.
//
// Pure: takes the environment as an argument, so it is testable without
// touching process.env. See docs/encryption-key-rotation.md for the runbook.
// ============================================================

/** The id the original, unversioned key is known by in status output. */
export const LEGACY_KEY_ID = "legacy";

const KEY_HEX = /^[0-9a-fA-F]{64}$/;
const KEY_ID = /^[A-Za-z0-9_-]{1,32}$/;

export class EncryptionConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionConfigError";
  }
}

export interface KeyRing {
  /** id -> 32-byte key. Includes the original key under LEGACY_KEY_ID when it is set. */
  keys: Map<string, Buffer>;
  /** The original ENCRYPTION_KEY, or null when only ENCRYPTION_KEYS is used. */
  legacy: Buffer | null;
  /** The key new ciphertexts are written with. */
  current: { id: string; key: Buffer; versioned: boolean };
}

type Env = Record<string, string | undefined>;

function toKey(hex: string, what: string): Buffer {
  const h = hex.trim();
  if (!KEY_HEX.test(h)) {
    throw new EncryptionConfigError(`${what} must be 64 hexadecimal characters (32 bytes)`);
  }
  return Buffer.from(h, "hex");
}

export function parseKeyRing(env: Env): KeyRing {
  const keys = new Map<string, Buffer>();

  const legacyHex = env.ENCRYPTION_KEY?.trim();
  const legacy = legacyHex ? toKey(legacyHex, "ENCRYPTION_KEY") : null;
  if (legacy) keys.set(LEGACY_KEY_ID, legacy);

  const extra = env.ENCRYPTION_KEYS?.trim();
  if (extra) {
    for (const entry of extra.split(",")) {
      const item = entry.trim();
      if (!item) continue;
      const at = item.indexOf(":");
      if (at < 1) throw new EncryptionConfigError("ENCRYPTION_KEYS entries must look like id:hexkey");
      const id = item.slice(0, at).trim();
      if (!KEY_ID.test(id)) {
        throw new EncryptionConfigError(`ENCRYPTION_KEYS id '${id}' must be 1-32 characters of A-Z a-z 0-9 _ -`);
      }
      if (id === LEGACY_KEY_ID) {
        throw new EncryptionConfigError(`ENCRYPTION_KEYS id '${LEGACY_KEY_ID}' is reserved for ENCRYPTION_KEY`);
      }
      if (keys.has(id)) throw new EncryptionConfigError(`ENCRYPTION_KEYS lists id '${id}' twice`);
      keys.set(id, toKey(item.slice(at + 1), `ENCRYPTION_KEYS key '${id}'`));
    }
  }

  if (keys.size === 0) {
    throw new EncryptionConfigError("ENCRYPTION_KEY is not configured");
  }

  const wanted = env.ENCRYPTION_KEY_ID?.trim();
  if (wanted) {
    const key = keys.get(wanted);
    if (!key) {
      throw new EncryptionConfigError(`ENCRYPTION_KEY_ID '${wanted}' is not one of the configured keys`);
    }
    return { keys, legacy, current: { id: wanted, key, versioned: wanted !== LEGACY_KEY_ID } };
  }

  // Not rotating: keep writing the original format under the original key.
  if (!legacy) {
    throw new EncryptionConfigError("ENCRYPTION_KEY_ID must be set when ENCRYPTION_KEY is not");
  }
  return { keys, legacy, current: { id: LEGACY_KEY_ID, key: legacy, versioned: false } };
}

let cached: { signature: string; ring: KeyRing } | null = null;

/** The ring for the process environment, re-parsed only when the variables change. */
export function getKeyRing(env: Env = process.env): KeyRing {
  const signature = `${env.ENCRYPTION_KEY ?? ""}|${env.ENCRYPTION_KEYS ?? ""}|${env.ENCRYPTION_KEY_ID ?? ""}`;
  if (cached && cached.signature === signature) return cached.ring;
  const ring = parseKeyRing(env);
  cached = { signature, ring };
  return ring;
}

/**
 * The key text to derive other secrets from (the Jira OAuth `state` signing
 * key): ENCRYPTION_KEY while it is configured, otherwise the key named by
 * ENCRYPTION_KEY_ID, otherwise the first of ENCRYPTION_KEYS. Lenient on
 * purpose (no hex validation): it only feeds an HMAC. Null when nothing is set.
 */
export function primaryKeyMaterial(env: Env = process.env): string | null {
  const legacy = env.ENCRYPTION_KEY?.trim();
  if (legacy) return env.ENCRYPTION_KEY as string;
  const entries = (env.ENCRYPTION_KEYS ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e) => {
      const at = e.indexOf(":");
      return at < 1 ? null : { id: e.slice(0, at).trim(), key: e.slice(at + 1).trim() };
    })
    .filter((e): e is { id: string; key: string } => e !== null && e.key !== "");
  const wanted = env.ENCRYPTION_KEY_ID?.trim();
  return (entries.find((e) => e.id === wanted) ?? entries[0])?.key ?? null;
}
