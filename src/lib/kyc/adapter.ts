// ============================================================
// KYC review: the adapter. THE ONE PLACE that guesses what the doc-processor back end sends.
//
// The back end's Postman collection (GET /validations?friend_id=&limit=, GET /validations/{id}/url) has NO example responses, so every field name,
// the status vocabulary and the shape of the list are PROVISIONAL guesses, all of them below. When engineers send real samples, correct the tables
// in the "Guesses" section and the tests in adapter.test.ts: nothing else in Halo knows a vendor field name.
//
// What this module does (pure, no I/O, no Node-only imports):
//   * extractItems       find the list in whatever the response is (an array, or an object holding one under a common key, or a single record)
//   * buildValidation    turn one raw record into a KycValidation: the known fields picked out under any of their likely names, every other scalar
//                        in a generic list, status words normalised to a tone, timestamps to ISO, and
//                        MASKING: a sensitive value (ID number, date of birth, address, ... any key matching SENSITIVE_PATTERNS) is replaced by a
//                        masked string or null here, on the server, unless the caller asks for it to be revealed for that one validation
//   * withholding        links, storage paths, tokens and very long values are NOT sent to the browser at all (counted in `withheld`): the vendor's
//                        image URL must never reach the browser
//   * extractSignedUrl   find the signed URL in the response of GET /validations/{id}/url (JSON in several shapes, a plain string, or a redirect)
//
// Never throws on odd input: a value it cannot read is left out or shown as text.
// ============================================================

import type { KycField, KycValidation, StatusTone } from "./types";
import { VALIDATION_ID_RE } from "./types";

// ------------------------------------------------------------
// Guesses (PROVISIONAL). Keys are compared after norm(): lower case, only letters and digits (created_at, createdAt and CreatedAt are all "createdat").
// ------------------------------------------------------------

/** Keys that may hold the list, when the response is an object (searched at the top and one level down). */
export const LIST_KEYS = ["validations", "items", "data", "results", "records", "rows", "documents", "checks"];

/** The record's own id (top level only). */
export const ID_KEYS = ["id", "validationid", "uuid", "recordid", "requestid", "checkid"];
export const FRIEND_ID_KEYS = ["friendid", "userid", "customerid", "memberid"];
export const TYPE_KEYS = ["type", "documenttype", "doctype", "idtype", "kind", "validationtype"];
export const STATUS_KEYS = ["status", "validationstatus", "verificationstatus", "state", "decision", "result", "outcome", "verdict"];
export const CREATED_KEYS = ["createdat", "created", "timestamp", "submittedat", "checkedat", "createdon", "date", "time"];
export const UPDATED_KEYS = ["updatedat", "modifiedat", "updated", "lastupdated", "processedat"];
export const REASON_KEYS = ["reason", "message", "failurereason", "errormessage", "error", "detail", "remarks", "comment", "note"];
export const SCORE_KEYS = ["confidence", "score", "confidencescore", "matchscore", "similarity", "probability"];

/** Personal fields shown as labelled rows. `mode`: how a masked value looks ("partial" = first 2 and last 2 characters, "hidden" = nothing). */
export interface KnownDef {
  name: string;
  label: string;
  keys: string[];
  mode: "partial" | "hidden" | null;
}
export const KNOWN_FIELDS: KnownDef[] = [
  { name: "name", label: "Name", keys: ["name", "fullname", "holdername", "cardholdername", "namefromid", "extractedname"], mode: null },
  { name: "idNumber", label: "ID number", keys: ["nric", "idnumber", "icnumber", "icno", "icnum", "idno", "documentnumber", "documentno", "passportnumber", "passportno", "identitynumber", "mykad", "mykid", "nationalid"], mode: "partial" },
  { name: "dob", label: "Date of birth", keys: ["dateofbirth", "dob", "birthdate", "birthday", "dateofbirthiso"], mode: "hidden" },
  { name: "address", label: "Address", keys: ["address", "fulladdress", "residentialaddress", "addressline1", "homeaddress"], mode: "hidden" },
];

/** Keys (normalised, searched as a substring of the whole path) whose value is masked until revealed, unless a KnownDef above says otherwise. */
export const SENSITIVE_PARTIAL = /(nric|icnum|icno|idnum|idno|identity|passport|mykad|mykid|nationalid|nationalno|documentnum|documentno|docnum|docno|ssn|taxid|licen[cs]e)/;
export const SENSITIVE_HIDDEN = /(dob|birth|address|street|postcode|postalcode|zipcode|phone|mobile|msisdn|email|parent|guardian|mother|father|gender|sex|race|religion|nationality)/;

/** Keys whose VALUE must never reach the browser (links, storage paths, credentials, raw image data). */
export const WITHHELD_KEYS = /(url|uri|link|href|bucket|s3|storage|filepath|path|signature|signed|token|secret|password|apikey|accesskey|secretkey|credential|authorization|base64|imagedata|blob|objectkey|imagekey|filekey)/;
/** Keys that may hold a file reference: withheld when the value is a string that looks like a path, a key or something long. */
export const FILE_LIKE_KEYS = /(image|photo|selfie|picture|scan|file|document)/;

export const POSITIVE_WORDS = ["approved", "approve", "verified", "passed", "pass", "ok", "success", "successful", "valid", "accepted", "matched", "match", "true"];
export const PENDING_WORDS = ["pending", "review", "processing", "queued", "submitted", "waiting", "inprogress", "progress", "manual", "flagged", "new", "created", "uploaded", "started"];
export const NEGATIVE_WORDS = ["rejected", "reject", "failed", "fail", "invalid", "mismatch", "declined", "denied", "error", "unverified", "unreadable", "blocked", "expired", "false", "no", "not", "cancelled", "canceled"];

/** Keys of the signed URL in the JSON answer of GET /validations/{id}/url (top level, then one level down). */
export const URL_KEYS = ["url", "signedurl", "link", "href", "downloadurl", "presignedurl", "imageurl", "documenturl", "location"];

// ------------------------------------------------------------
// Limits
// ------------------------------------------------------------
const MAX_DEPTH = 3;
const MAX_FIELDS = 120;
const MAX_VALUE_CHARS = 300;
const LONG_VALUE_CHARS = 600;
const MAX_ARRAY_ITEMS = 20;

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------
type Json = unknown;

export const isObject = (v: Json): v is Record<string, Json> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Compare keys without caring about case or separators. */
export function norm(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface Entry {
  /** The vendor's path, dotted (a.b.0.c). */
  path: string;
  /** Normalised last segment. */
  leaf: string;
  /** Normalised whole path (segments joined). */
  full: string;
  depth: number;
  value: string | number | boolean;
}

function cleanText(s: string): string {
  // Control characters and the bidi overrides (which can make text read as something else) never reach a screen or a CSV.
  return s.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "").replace(/\s+/g, " ").trim();
}

/** Flatten a record into scalar entries. Nulls and empty strings are dropped; nesting is followed to MAX_DEPTH; arrays to MAX_ARRAY_ITEMS entries. */
function flatten(raw: Record<string, Json>): Entry[] {
  const out: Entry[] = [];
  const walk = (node: Json, segs: string[], depth: number): void => {
    if (out.length >= MAX_FIELDS * 2) return;
    if (Array.isArray(node)) {
      node.slice(0, MAX_ARRAY_ITEMS).forEach((v, i) => walk(v, [...segs, String(i)], depth + 1));
      return;
    }
    if (isObject(node)) {
      if (depth >= MAX_DEPTH) return;
      for (const [k, v] of Object.entries(node)) walk(v, [...segs, k], depth + 1);
      return;
    }
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      if (node.trim() === "") return;
    } else if (typeof node !== "number" && typeof node !== "boolean") return;
    if (segs.length === 0) return;
    const last = segs[segs.length - 1];
    out.push({
      path: segs.join("."),
      leaf: norm(last),
      full: segs.map(norm).join(""),
      depth: segs.length - 1,
      value: node as string | number | boolean,
    });
  };
  walk(raw, [], 0);
  return out;
}

/** The first entry that matches a candidate, trying the candidates in priority order and the shallowest entry first. */
function pick(entries: Entry[], candidates: readonly string[], opts: { maxDepth?: number; scalar?: "string" | "number" } = {}): Entry | null {
  for (const cand of candidates) {
    let best: Entry | null = null;
    for (const e of entries) {
      if (e.leaf !== cand) continue;
      if (opts.maxDepth !== undefined && e.depth > opts.maxDepth) continue;
      if (opts.scalar === "number" && !Number.isFinite(toNumber(e.value) ?? NaN)) continue;
      if (best === null || e.depth < best.depth) best = e;
    }
    if (best) return best;
  }
  return null;
}

function toNumber(v: string | number | boolean): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return null;
}

function text(v: string | number | boolean, max = MAX_VALUE_CHARS): string {
  const s = cleanText(String(v));
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ------------------------------------------------------------
// Dates
// ------------------------------------------------------------
/** An ISO 8601 (UTC) string for a vendor timestamp (ISO text, epoch seconds or milliseconds, as a number or numeric text), or null. */
export function toIso(v: string | number | boolean): string | null {
  if (typeof v === "boolean") return null;
  let ms: number | null = null;
  const n = toNumber(v);
  if (n !== null) {
    if (n >= 1e12 && n < 1e14) ms = n;
    else if (n >= 1e9 && n < 1e11) ms = n * 1000;
  } else if (typeof v === "string") {
    const t = Date.parse(v.trim());
    if (Number.isFinite(t)) ms = t;
  }
  if (ms === null) return null;
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  return Number.isNaN(d.getTime()) || year < 2000 || year > 2100 ? null : d.toISOString();
}

// ------------------------------------------------------------
// Status
// ------------------------------------------------------------
/** The tone of a vendor status word. Negative beats pending beats positive, so "not_verified" and "verification_failed" are red, "pending_review" amber. */
export function statusTone(raw: string | null): StatusTone {
  if (!raw) return "neutral";
  const words = raw
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length === 0) return "neutral";
  const joined = words.join("");
  const has = (list: string[]) => words.some((w) => list.includes(w)) || list.includes(joined);
  if (has(NEGATIVE_WORDS)) return "negative";
  if (has(PENDING_WORDS)) return "pending";
  if (has(POSITIVE_WORDS)) return "positive";
  return "neutral";
}

// ------------------------------------------------------------
// Masking
// ------------------------------------------------------------
const DOT = "•";

/**
 * A masked rendering of a sensitive value, or null for "show nothing". "partial" keeps the first 2 and last 2 characters of a value of at least 10
 * (a 12-digit NRIC becomes `90••••••••34`, a fixed number of dots so the length is not revealed); a shorter value, and every "hidden" one, is null.
 * Note for engineers: the first two digits of a Malaysian NRIC are the year of birth; change the rule here if compliance does not want that shown.
 */
export function maskValue(value: string, mode: "partial" | "hidden"): string | null {
  const v = cleanText(value);
  if (mode === "hidden" || v.length < 10) return null;
  return `${v.slice(0, 2)}${DOT.repeat(6)}${v.slice(-2)}`;
}

/** How a path is masked: a KnownDef's mode if it has one, otherwise by the sensitive patterns. null = not sensitive. */
export function sensitiveMode(fullPath: string, known?: KnownDef): "partial" | "hidden" | null {
  if (known) return known.mode;
  if (SENSITIVE_PARTIAL.test(fullPath)) return "partial";
  if (SENSITIVE_HIDDEN.test(fullPath)) return "hidden";
  return null;
}

// ------------------------------------------------------------
// The list
// ------------------------------------------------------------
function listKeyIndex(o: Record<string, Json>): string[] {
  return Object.keys(o).filter((k) => LIST_KEYS.includes(norm(k)));
}

/** Does this object look like ONE record (it has an id or a status of its own)? */
function looksLikeRecord(o: Record<string, Json>): boolean {
  return Object.keys(o).some((k) => ID_KEYS.includes(norm(k)) || STATUS_KEYS.includes(norm(k)));
}

/**
 * The records in a list response. Accepts an array; an object holding an array under one of LIST_KEYS (at the top or one level down, so
 * `{ data: { validations: [...] } }` works); a single record; or an empty object (nothing on file). Returns null for anything else (an error
 * message object, text, a number), which the caller reports as a bad response.
 */
export function extractItems(body: Json): Record<string, Json>[] | null {
  const onlyObjects = (arr: Json[]): Record<string, Json>[] | null => {
    const objs = arr.filter(isObject);
    if (arr.length > 0 && objs.length === 0) return null;
    return objs;
  };
  if (Array.isArray(body)) return onlyObjects(body);
  if (!isObject(body)) return null;
  for (const k of listKeyIndex(body)) {
    const v = body[k];
    if (Array.isArray(v)) return onlyObjects(v);
  }
  for (const k of listKeyIndex(body)) {
    const v = body[k];
    if (isObject(v)) {
      for (const k2 of listKeyIndex(v)) {
        const v2 = v[k2];
        if (Array.isArray(v2)) return onlyObjects(v2);
      }
      if (looksLikeRecord(v)) return [v];
    }
  }
  if (looksLikeRecord(body)) return [body];
  if (Object.keys(body).length === 0) return [];
  // an object whose list keys hold empty or null values: nothing on file
  if (listKeyIndex(body).length > 0 && listKeyIndex(body).every((k) => body[k] === null || body[k] === undefined)) return [];
  return null;
}

// ------------------------------------------------------------
// One record
// ------------------------------------------------------------
export interface BuildOptions {
  /** Show this validation's sensitive values in full. The caller has checked kyc.reveal. */
  reveal?: boolean;
}

function scoreText(e: Entry | null): string | null {
  if (!e) return null;
  const n = toNumber(e.value);
  if (n === null) return null;
  if (n >= 0 && n <= 1) return `${Math.round(n * 1000) / 10}%`;
  return String(Math.round(n * 100) / 100);
}

function typeText(e: Entry | null): string | null {
  if (!e) return null;
  const s = text(e.value, 60);
  if (!s) return null;
  return s.length <= 14 ? s.toUpperCase() : s;
}

/** A path that must not reach the browser, judged by its key and its value. */
function isWithheld(e: Entry): boolean {
  const v = e.value;
  if (typeof v === "string") {
    if (/^[a-z][a-z0-9+.-]{1,12}:\/\//i.test(v.trim()) || /^data:/i.test(v.trim())) return true;
    if (v.length > LONG_VALUE_CHARS) return true;
  }
  if (WITHHELD_KEYS.test(e.full)) return true;
  if (FILE_LIKE_KEYS.test(e.full) && typeof v === "string" && (v.length > 40 || v.includes("/"))) return true;
  return false;
}

export function buildValidation(raw: Record<string, Json>, opts: BuildOptions = {}): KycValidation {
  const entries = flatten(raw);
  const used = new Set<string>();
  let withheld = 0;
  // A field taken for a known role is not listed again; one that must not reach the browser is counted and dropped, whichever role it was taken for.
  const take = (e: Entry | null): Entry | null => {
    if (!e) return null;
    used.add(e.path);
    if (isWithheld(e)) {
      withheld += 1;
      return null;
    }
    return e;
  };

  const idE = take(pick(entries, ID_KEYS, { maxDepth: 0 }));
  const idRaw = idE ? text(idE.value, 200) : "";
  const friendE = take(pick(entries, FRIEND_ID_KEYS, { maxDepth: 1 }));
  const typeE = take(pick(entries, TYPE_KEYS));
  const statusE = take(pick(entries, STATUS_KEYS));
  const createdE = take(pick(entries, CREATED_KEYS));
  const updatedE = take(pick(entries, UPDATED_KEYS));
  const reasonE = take(pick(entries, REASON_KEYS));
  const scoreE = take(pick(entries, SCORE_KEYS, { scalar: "number" }));

  const rawStatus = statusE ? (typeof statusE.value === "boolean" ? String(statusE.value) : text(statusE.value, 60)) : null;

  const reveal = opts.reveal === true;
  const known: KycField[] = [];
  let hasMasked = false;

  const makeField = (key: string, label: string | null, value: string, mode: "partial" | "hidden" | null): KycField => {
    if (mode === null) return { key, label, value, sensitive: false, masked: false };
    if (reveal) return { key, label, value, sensitive: true, masked: false };
    hasMasked = true;
    return { key, label, value: maskValue(value, mode), sensitive: true, masked: true };
  };

  for (const def of KNOWN_FIELDS) {
    const e = take(pick(entries.filter((x) => !used.has(x.path)), def.keys));
    if (!e) continue;
    known.push(makeField(def.name, def.label, text(e.value), def.mode));
  }

  const extra: KycField[] = [];
  for (const e of entries) {
    if (used.has(e.path)) continue;
    if (isWithheld(e)) {
      withheld += 1;
      continue;
    }
    if (extra.length >= MAX_FIELDS) break;
    extra.push(makeField(e.path, null, text(e.value), sensitiveMode(e.full)));
  }
  const createdIso = createdE ? toIso(createdE.value) : null;
  const id = idRaw;

  const fallback = !(typeE || statusE || createdE || scoreE || reasonE || known.length > 0);

  return {
    id: id || "",
    idUsable: id !== "" && VALIDATION_ID_RE.test(id),
    friendId: friendE ? text(friendE.value, 100) : null,
    type: typeText(typeE),
    status: { raw: rawStatus && rawStatus !== "" ? rawStatus : null, tone: statusTone(rawStatus) },
    createdAt: createdIso,
    createdAtRaw: createdE ? text(createdE.value, 60) : null,
    updatedAt: updatedE ? toIso(updatedE.value) : null,
    score: scoreText(scoreE),
    reason: reasonE ? text(reasonE.value) : null,
    known,
    extra,
    withheld,
    fallback,
    hasMasked,
  };
}

export interface ParsedList {
  items: KycValidation[];
  fallback: boolean;
}

/** Newest first; a record with no readable time goes last, in the vendor's order. */
export function sortNewestFirst<T extends { createdAt: string | null }>(items: readonly T[]): T[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const ta = a.item.createdAt ? Date.parse(a.item.createdAt) : NaN;
      const tb = b.item.createdAt ? Date.parse(b.item.createdAt) : NaN;
      if (Number.isNaN(ta) && Number.isNaN(tb)) return a.i - b.i;
      if (Number.isNaN(ta)) return 1;
      if (Number.isNaN(tb)) return -1;
      return tb - ta || a.i - b.i;
    })
    .map((x) => x.item);
}

/**
 * The whole list response, ready for the screen. `revealId` names the ONE validation whose sensitive values are shown in full (the caller must
 * hold kyc.reveal); every other validation stays masked. Returns null when the body is not a list (bad response).
 */
export function parseValidations(body: Json, opts: { limit?: number; revealId?: string | null } = {}): ParsedList | null {
  const records = extractItems(body);
  if (records === null) return null;
  const limit = Math.max(1, Math.min(100, opts.limit ?? 100));
  const built = records.slice(0, limit).map((r) => buildValidation(r));
  // Rebuild the one revealed validation unmasked (the records are small; this keeps buildValidation's contract simple).
  const items = built.map((v, i) => (opts.revealId && v.id !== "" && v.id === opts.revealId ? buildValidation(records[i], { reveal: true }) : v));
  const sorted = sortNewestFirst(items);
  return { items: sorted, fallback: sorted.length > 0 && sorted.every((v) => v.fallback) };
}

// ------------------------------------------------------------
// The signed URL
// ------------------------------------------------------------
export interface SignedUrlResponse {
  status: number;
  /** The Location header, if any. */
  location: string | null;
  /** The body as text (already size-capped by the caller); empty when none. */
  bodyText: string;
}

/** Does a string look like an address to fetch? (the guard in ssrf.ts decides whether it is allowed) */
function urlLike(s: unknown): s is string {
  return typeof s === "string" && /^https?:\/\/\S+$/i.test(s.trim());
}

function urlFromJson(body: Json): string | null {
  if (urlLike(body)) return body.trim();
  if (!isObject(body)) return null;
  for (const cand of URL_KEYS) {
    for (const k of Object.keys(body)) {
      if (norm(k) === cand && urlLike(body[k])) return (body[k] as string).trim();
    }
  }
  for (const k of Object.keys(body)) {
    const v = body[k];
    if (isObject(v)) {
      const inner = urlFromJson(v);
      if (inner) return inner;
    }
  }
  return null;
}

/**
 * The signed URL out of the response of GET /validations/{id}/url: a redirect (its Location), a JSON object with the URL under one of URL_KEYS
 * (top level or nested), a JSON string, or the URL as plain text. Returns null when there is none. The caller must still run it through the
 * SSRF guard (ssrf.ts): this only finds it.
 */
export function extractSignedUrl(res: SignedUrlResponse): string | null {
  if (res.status >= 300 && res.status < 400) {
    const loc = res.location?.trim();
    return loc ? loc : null;
  }
  const t = res.bodyText.trim();
  if (!t) return null;
  if (t.startsWith("{") || t.startsWith("[") || t.startsWith('"')) {
    try {
      return urlFromJson(JSON.parse(t) as Json);
    } catch {
      return null;
    }
  }
  return urlLike(t) ? t : null;
}

/** Everything this file guesses, for the engineers' documentation and a test that keeps the docs honest. */
export const ADAPTER_GUESSES = {
  listKeys: LIST_KEYS,
  idKeys: ID_KEYS,
  friendIdKeys: FRIEND_ID_KEYS,
  typeKeys: TYPE_KEYS,
  statusKeys: STATUS_KEYS,
  createdKeys: CREATED_KEYS,
  updatedKeys: UPDATED_KEYS,
  reasonKeys: REASON_KEYS,
  scoreKeys: SCORE_KEYS,
  known: KNOWN_FIELDS.map((k) => ({ name: k.name, keys: k.keys, mode: k.mode })),
  positiveWords: POSITIVE_WORDS,
  pendingWords: PENDING_WORDS,
  negativeWords: NEGATIVE_WORDS,
  urlKeys: URL_KEYS,
} as const;
