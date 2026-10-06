// ============================================================
// Doc Sign, signing page: the logic of the page that has no screen in it. Pure, so it is tested without
// a browser (signer-flow.test.ts).
//
//   language           which language the page is shown in
//   screen             which of the page's screens a view shows
//   fields and answers what is left to do, in what order, what may be sent
//   AutosaveQueue      answers saved in small batches, with retry when the connection drops
//   polling            how often a "we are finishing" page asks again
// ============================================================

import { normalizeLocale, type SupportedLocale } from "@/lib/i18n/locales";

import { formatDate } from "../pdf/format";
import type { PlacedField } from "../pdf/types";
import { checkAnswer, fieldsForRole, type AnswerInput, type StoredAnswer } from "../rules";
import type { OtherSigner, PageState } from "../service/signing";
import type { PartProgress } from "../forms/types";
import { checkImageDataUrl } from "./signer-images";

// ---- language -----------------------------------------------------------------------------------

export type SignerLocale = SupportedLocale;

type Maybe = string | string[] | null | undefined;

/**
 * The language the page is shown in: the address's `?lang=` when it names one of the four, then the
 * document's own language, then `fallback`, then English. A value that is not a language is passed over.
 */
export function resolveSignerLocale(choice: { query?: Maybe; document?: string | null; fallback?: string | null }): SignerLocale {
  const query = Array.isArray(choice.query) ? choice.query[0] : choice.query;
  return normalizeLocale(query) ?? normalizeLocale(choice.document) ?? normalizeLocale(choice.fallback) ?? "en";
}

/**
 * The page's language from an Accept-Language header ("ms-MY,ms;q=0.9,en;q=0.8"): the first language the
 * page has, most preferred first. English when there is none. For the pages that have no document to ask.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): SignerLocale {
  const ranked = (header ?? "")
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => /^\s*q=([\d.]+)\s*$/.exec(p)?.[1]).find((v) => v !== undefined);
      return { tag, q: q === undefined ? 1 : Number(q), index };
    })
    .filter((x) => x.tag && Number.isFinite(x.q) && x.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  for (const { tag } of ranked) {
    const locale = normalizeLocale(tag);
    if (locale) return locale;
  }
  return "en";
}

// ---- which screen -------------------------------------------------------------------------------

/** `active` is never shown as itself: it is the code, the agreement or the document. */
export type Screen = Exclude<PageState, "active"> | "code" | "consent" | "fill";

/** What the page shows for a view: the code first, then the agreement, then the document itself. */
export function screenFor(view: { state: PageState; needsCode: boolean; needsConsent: boolean }): Screen {
  if (view.needsCode && (view.state === "active" || view.state === "signed")) return "code";
  if (view.state === "active") return view.needsConsent ? "consent" : "fill";
  return view.state;
}

/** An end state: nothing more can be done on this page (it may still change by itself, see `shouldPoll`). */
export function isEndScreen(screen: Screen): boolean {
  return screen !== "code" && screen !== "consent" && screen !== "fill";
}

/** Only a document being sealed changes without the signer doing anything. */
export function shouldPoll(screen: Screen): boolean {
  return screen === "sealing";
}

const POLL_FAST_MS = 5_000;
const POLL_FAST_FOR_MS = 2 * 60_000;

/** How long to wait before asking again: every 5 seconds for two minutes, then less and less often. */
export function pollDelayMs(elapsedMs: number): number {
  if (elapsedMs < POLL_FAST_FOR_MS) return POLL_FAST_MS;
  if (elapsedMs < 5 * 60_000) return 15_000;
  if (elapsedMs < 15 * 60_000) return 30_000;
  return 60_000;
}

// ---- the other people ---------------------------------------------------------------------------

export type OtherKind = "signed" | "declined" | "turn" | "invited" | "waiting";

export interface OtherRow {
  name: string;
  /** A filler completes fields; a signer signs. The words differ. */
  filler: boolean;
  kind: OtherKind;
  signedAt: string | null;
}

/**
 * How each other person stands. With signing order, an invited person who has not finished is "turn"
 * (the first of them only) and the rest wait; without order everyone invited is simply "invited".
 */
export function describeOthers(others: readonly OtherSigner[], signInOrder: boolean): OtherRow[] {
  const sorted = [...others].sort((a, b) => a.orderNo - b.orderNo);
  let turnGiven = false;
  return sorted.map((o) => {
    const filler = o.kind === "filler";
    let kind: OtherKind;
    if (o.status === "signed") kind = "signed";
    else if (o.status === "declined") kind = "declined";
    else if (o.status === "pending") kind = "waiting";
    else if (!signInOrder) kind = "invited";
    else if (!turnGiven) {
      kind = "turn";
      turnGiven = true;
    } else kind = "waiting";
    return { name: o.name, filler, kind, signedAt: o.signedAt };
  });
}

/** How many of the others have not finished (and have not declined). */
export function othersStillToSign(others: readonly OtherSigner[]): number {
  return others.filter((o) => o.status !== "signed" && o.status !== "declined").length;
}

// ---- answers --------------------------------------------------------------------------------------

/** What the page holds for each field the signer fills: the same shape the server takes. */
export type Answers = Record<string, AnswerInput>;
/** Why the server turned a field's value down, by field key. */
export type Rejections = Record<string, string>;

export function inputFromStored(stored: StoredAnswer): AnswerInput {
  if ("text" in stored) return { text: stored.text };
  if ("checked" in stored) return { checked: stored.checked };
  if ("image" in stored) return { image: stored.image };
  return { typed: stored.typed };
}

export function answersFromStored(stored: Record<string, StoredAnswer>): Answers {
  const out: Answers = {};
  for (const [key, value] of Object.entries(stored)) out[key] = inputFromStored(value);
  return out;
}

const isFilled = (v: unknown): boolean => v !== undefined && v !== null && v !== "";

/** Does this input hold anything at all? */
export function hasValue(input: AnswerInput | undefined): boolean {
  if (!input) return false;
  return isFilled(input.text) || typeof input.checked === "boolean" || isFilled(input.image) || isFilled(input.typed);
}

export type AnswerCheck = { status: "empty" } | { status: "ok" } | { status: "invalid"; code: string };

/**
 * Check one value for its field, the way the server will. `checkAnswer` is the server's own function;
 * only the picture test is done here, because the server's reads the bytes with Node's Buffer.
 */
export function evaluateAnswer(field: PlacedField, input: AnswerInput | undefined): AnswerCheck {
  if (!input) return { status: "empty" };
  const imageType = field.type === "signature" || field.type === "initials" || field.type === "upload";
  if (imageType && isFilled(input.image)) return checkImageDataUrl(input.image) ? { status: "ok" } : { status: "invalid", code: "bad_image" };
  const r = checkAnswer(field, input);
  if (!r.ok) return { status: "invalid", code: r.code };
  return r.value === null ? { status: "empty" } : { status: "ok" };
}

export type FieldStatus = "done" | "todo" | "optional" | "invalid";

/** Where a field stands: done, still to do (required), optional and empty, or a value that is not acceptable. */
export function fieldStatus(field: PlacedField, answers: Answers, rejected: Rejections = {}): FieldStatus {
  if (rejected[field.key]) return "invalid";
  const c = evaluateAnswer(field, answers[field.key]);
  if (c.status === "invalid") return "invalid";
  if (c.status === "ok") return "done";
  return field.required ? "todo" : "optional";
}

/** The reason a field is marked: the server's, or what checking it here found. */
export function fieldProblem(field: PlacedField, answers: Answers, rejected: Rejections = {}): string | null {
  if (rejected[field.key]) return rejected[field.key];
  const c = evaluateAnswer(field, answers[field.key]);
  return c.status === "invalid" ? c.code : null;
}

// ---- the fields, in reading order -------------------------------------------------------------------

/** Page by page, top to bottom (rows one percent of a page tall count as one row), left to right. */
export function readingOrder<T extends Pick<PlacedField, "key" | "page" | "x" | "y">>(fields: readonly T[]): T[] {
  return [...fields].sort((a, b) => a.page - b.page || Math.floor(a.y * 100) - Math.floor(b.y * 100) || a.x - b.x || a.key.localeCompare(b.key));
}

export interface SignerFields {
  /** The fields this person fills in, in reading order. */
  mine: PlacedField[];
  /** The person's name and the signing date: written by the system, shown as "filled in for you". */
  system: PlacedField[];
}

export function signerFields(fields: readonly PlacedField[], roleKey: string): SignerFields {
  return {
    mine: readingOrder(fieldsForRole(fields, roleKey)),
    system: readingOrder(fields.filter((f) => f.role === roleKey && (f.type === "name" || f.type === "date_signed"))),
  };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The boxes to tap: each field grown around its middle to at least `min` pixels each way (a finger needs
 * 44), but never into a neighbour. Where fields sit closer than that, each keeps half the gap, so two
 * boxes never overlap and a tap always goes to the field it was aimed at. In fractions of the page, keyed
 * by field key; `page` is the size on screen in pixels.
 */
export function touchRects(fields: readonly Pick<PlacedField, "key" | "x" | "y" | "w" | "h">[], page: { width: number; height: number }, min = 44): Record<string, Rect> {
  const px = fields.map((f) => {
    const box = { key: f.key, x: f.x * page.width, y: f.y * page.height, w: f.w * page.width, h: f.h * page.height };
    return { ...box, gx: Math.max(0, min - box.w) / 2, gy: Math.max(0, min - box.h) / 2 };
  });
  const out: Record<string, Rect> = {};
  for (const a of px) {
    let left = a.gx;
    let right = a.gx;
    let up = a.gy;
    let down = a.gy;
    for (const b of px) {
      if (b === a) continue;
      // only two boxes that would run into each other when both are grown need to share the gap
      const meet = b.x - b.gx < a.x + a.w + a.gx && b.x + b.w + b.gx > a.x - a.gx && b.y - b.gy < a.y + a.h + a.gy && b.y + b.h + b.gy > a.y - a.gy;
      if (!meet) continue;
      const below = b.y - (a.y + a.h);
      const above = a.y - (b.y + b.h);
      const right_ = b.x - (a.x + a.w);
      const left_ = a.x - (b.x + b.w);
      if (below < 0 && above < 0 && right_ < 0 && left_ < 0) {
        // the fields themselves overlap: nothing to grow into
        left = right = up = down = 0;
        break;
      }
      // the direction the other field lies in is the one with the smallest gap
      const gap = Math.min(...[below, above, right_, left_].filter((g) => g >= 0));
      if (gap === below) down = Math.min(down, gap / 2);
      else if (gap === above) up = Math.min(up, gap / 2);
      else if (gap === right_) right = Math.min(right, gap / 2);
      else left = Math.min(left, gap / 2);
    }
    out[a.key] = { x: (a.x - left) / page.width, y: (a.y - up) / page.height, w: (a.w + left + right) / page.width, h: (a.h + up + down) / page.height };
  }
  return out;
}

export interface Progress {
  /** Required fields in all, and how many of them are done. */
  required: number;
  done: number;
  /** Keys, in reading order, that stand in the way of finishing: required and empty, or not acceptable. */
  attention: string[];
  canFinish: boolean;
}

export function computeProgress(mine: readonly PlacedField[], answers: Answers, rejected: Rejections = {}): Progress {
  let required = 0;
  let done = 0;
  const attention: string[] = [];
  for (const f of mine) {
    const status = fieldStatus(f, answers, rejected);
    if (f.required) {
      required++;
      if (status === "done") done++;
    }
    if (status === "todo" || status === "invalid") attention.push(f.key);
  }
  return { required, done, attention, canFinish: attention.length === 0 };
}

/**
 * The field "Next" goes to: the first one needing attention after `afterKey` in reading order, and past
 * the last, round to the first. Null when nothing needs attention.
 */
export function nextAttentionKey(mine: readonly PlacedField[], attention: readonly string[], afterKey?: string | null): string | null {
  if (attention.length === 0) return null;
  const needs = new Set(attention);
  const start = afterKey ? mine.findIndex((f) => f.key === afterKey) + 1 : 0;
  for (let i = 0; i < mine.length; i++) {
    const f = mine[(start + i) % mine.length];
    if (needs.has(f.key) && f.key !== afterKey) return f.key;
  }
  return afterKey && needs.has(afterKey) ? afterKey : null;
}

// ---- building answers from what the person did -------------------------------------------------------

export const textAnswer = (text: string): AnswerInput => ({ text });

/** A ticked box is the answer `true`; an unticked one is no answer at all, so a required box stays required. */
export const checkboxAnswer = (checked: boolean): AnswerInput => (checked ? { checked: true } : {});

export const imageAnswer = (dataUrl: string): AnswerInput => ({ image: dataUrl });

export const clearedAnswer = (): AnswerInput => ({});

/** Initials from a name: "Ali bin Ahmad" is "ABA"; a name without spaces in Chinese or Korean is its first two characters. */
export function initialsOf(name: string): string {
  const words = name.normalize("NFC").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1 && /[⺀-鿿가-힯]/.test(words[0])) return Array.from(words[0]).slice(0, 2).join("");
  return words
    .map((w) => Array.from(w)[0].toUpperCase())
    .join("")
    .slice(0, 10);
}

/** A typed signature (or typed initials) as an answer. Empty when there is nothing typed. */
export function typedAnswer(field: Pick<PlacedField, "type">, typed: string): AnswerInput {
  const t = typed.trim();
  if (!t) return {};
  return { typed: field.type === "initials" ? Array.from(t).slice(0, 10).join("") : Array.from(t).slice(0, 100).join("") };
}

/**
 * Can this be written in the script font? The PDF engine's fonts cover Latin letters (with accents, so
 * Malay and Vietnamese are fine); other writing would come out as question marks on the signed page, so
 * the page does not let it be typed as a signature. Drawing or uploading works for any writing.
 */
export function canTypeSignature(text: string): boolean {
  return text.length > 0 && /^[\p{Script=Latin}\p{M}\p{Nd}\s.,'’-]+$/u.test(text.normalize("NFC"));
}

/** A signature the person adopted: kept for the other places they have to sign or initial. */
export type Adopted = { mode: "draw" | "upload"; image: string } | { mode: "type"; typed: string };

/** The adopted signature as the answer for a field: initials from a typed name are its initials; a picture serves for both. */
export function answerFromAdopted(field: Pick<PlacedField, "type">, adopted: Adopted): AnswerInput {
  if (adopted.mode === "type") return typedAnswer(field, field.type === "initials" ? initialsOf(adopted.typed) : adopted.typed);
  return imageAnswer(adopted.image);
}

/** Make the adopted signature from what a signature field now holds, or null when it holds nothing to reuse. */
export function adoptedFromInput(input: AnswerInput | undefined, mode: "draw" | "type" | "upload"): Adopted | null {
  if (!input) return null;
  if (mode === "type") return typeof input.typed === "string" && input.typed ? { mode: "type", typed: input.typed } : null;
  return typeof input.image === "string" && input.image ? { mode, image: input.image } : null;
}

/** What the system writes for a field the person does not fill: their name, or the signing date. */
export function systemFieldText(field: PlacedField, signerName: string, now: Date, locale: SignerLocale, timeZone?: string): string {
  if (field.type === "name") return signerName;
  return formatDate(now, field.dateFormat, locale, timeZone ?? "UTC");
}

/**
 * The answers to send with "Finish": every acceptable answer for a field of this person. A value the
 * server already has (`isSaved`) is left out when it is a picture, so the request stays small however
 * many places the same signature is used.
 */
export function completionPayload(mine: readonly PlacedField[], answers: Answers, isSaved: (key: string, input: AnswerInput) => boolean): Answers {
  const out: Answers = {};
  for (const f of mine) {
    const input = answers[f.key];
    if (!input || evaluateAnswer(f, input).status !== "ok") continue;
    const picture = isFilled(input.image);
    if (picture && isSaved(f.key, input)) continue;
    out[f.key] = input;
  }
  return out;
}

// ---- saving as the person goes ---------------------------------------------------------------------------

export type SaveState = "idle" | "saving" | "saved" | "offline" | "error";

export interface SaveResponse {
  saved: string[];
  rejected: { field: string; code: string; detail?: string }[];
  /** A document with a form: where each of the signer's parts stands now, whether signing may open, and the answers still from the contact. */
  progress?: PartProgress[];
  ready?: boolean;
  unconfirmed?: string[];
}

export interface AutosaveOptions<V extends object = AnswerInput> {
  /** Send a batch (and, only when there are any, the parts the signer confirmed). Throws when the request fails. */
  send: (batch: Record<string, V>, confirmParts?: string[]) => Promise<SaveResponse>;
  /** Is this failure worth another try (no connection, a busy or broken server)? */
  isRetryable: (err: unknown) => boolean;
  /** Is it specifically "no connection"? Shown as offline rather than as an error. */
  isOffline?: (err: unknown) => boolean;
  onState?: (state: SaveState) => void;
  /** Values the server turned down, with the reason. They are not sent again until they change. */
  onRejected?: (rejected: { field: string; code: string; detail?: string }[]) => void;
  /** The server accepted a batch: what it answered (progress of a form's parts, whether signing may open). */
  onSaved?: (result: SaveResponse) => void;
  /** A failure that trying again will not fix (the session ended, the link is gone). The values stay queued. */
  onFailure?: (err: unknown) => void;
  /** Wait after the last change before sending (default one second). */
  debounceMs?: number;
  /** Waits between tries after a failure; the last one repeats. */
  retryDelaysMs?: readonly number[];
  /** A batch is cut when its values (as JSON) pass this many characters, so one request stays small. */
  maxBatchChars?: number;
}

const DEFAULT_RETRY_DELAYS = [2_000, 5_000, 10_000, 20_000, 30_000];

/**
 * The newest value of each changed field, sent together after a short pause. A failed send is tried again
 * (a value changed meanwhile keeps its newer value); nothing is lost while the connection is down.
 */
export class AutosaveQueue<V extends object = AnswerInput> {
  private readonly opts: AutosaveOptions<V>;
  private readonly pending = new Map<string, V>();
  private readonly lastSaved = new Map<string, V>();
  /** Parts of a form the signer confirmed (their answers from the contact are now theirs), sent with the next batch. */
  private readonly confirms = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  private failures = 0;
  private disposed = false;
  private current: SaveState = "idle";

  constructor(opts: AutosaveOptions<V>) {
    this.opts = opts;
  }

  get state(): SaveState {
    return this.current;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /** The value of `key` is now `input`. */
  set(key: string, input: V): void {
    if (this.disposed) return;
    this.pending.set(key, input);
    this.lastSaved.delete(key);
    if (this.current !== "offline" && this.current !== "error") this.setState("saving");
    // while a retry is already waiting, the change rides along with it
    if (this.failures === 0 || this.timer === null) this.schedule(this.opts.debounceMs ?? 1000);
  }

  /** Has the server been given exactly this value for `key`? */
  isSaved(key: string, input: V): boolean {
    return this.lastSaved.get(key) === input;
  }

  /** The signer confirmed a part: its answers that came from the contact are saved as theirs, at once, with whatever else is waiting. */
  confirmPart(partKey: string): void {
    if (this.disposed) return;
    this.confirms.add(partKey);
    if (this.current !== "offline" && this.current !== "error") this.setState("saving");
    this.clearTimer();
    void this.drain();
  }

  /** Send everything now. True when nothing is left unsaved. */
  async flush(): Promise<boolean> {
    this.clearTimer();
    await this.drain();
    return this.pending.size === 0 && this.confirms.size === 0;
  }

  /** Try again at once (the connection came back, the signer entered the code again). */
  retryNow(): void {
    if (this.pending.size === 0 && this.confirms.size === 0) return;
    this.failures = 0;
    this.clearTimer();
    void this.drain();
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  /** Work again after `dispose` (React runs an effect's cleanup and then the effect again in development). */
  revive(): void {
    this.disposed = false;
    if (this.pending.size > 0 || this.confirms.size > 0) this.schedule(this.opts.debounceMs ?? 1000);
  }

  private setState(state: SaveState): void {
    if (this.current === state) return;
    this.current = state;
    this.opts.onState?.(state);
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.drain();
    }, ms);
  }

  private async drain(): Promise<void> {
    while (this.running) await this.running;
    if (this.disposed || (this.pending.size === 0 && this.confirms.size === 0)) return;
    this.running = this.run();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  /** Take the oldest values that fit one request out of the queue. */
  private takeBatch(): Map<string, V> {
    const max = this.opts.maxBatchChars ?? 1_800_000;
    const batch = new Map<string, V>();
    let size = 0;
    for (const [key, input] of this.pending) {
      const length = JSON.stringify(input).length;
      if (batch.size > 0 && size + length > max) break;
      batch.set(key, input);
      size += length;
    }
    for (const key of batch.keys()) this.pending.delete(key);
    return batch;
  }

  private async run(): Promise<void> {
    while (!this.disposed && (this.pending.size > 0 || this.confirms.size > 0)) {
      const batch = this.takeBatch();
      const confirmed = [...this.confirms];
      this.confirms.clear();
      this.setState("saving");
      try {
        const result = confirmed.length > 0 ? await this.opts.send(Object.fromEntries(batch), confirmed) : await this.opts.send(Object.fromEntries(batch));
        this.failures = 0;
        const refused = new Set(result.rejected.map((r) => r.field));
        for (const [key, input] of batch) if (!refused.has(key) && !this.pending.has(key)) this.lastSaved.set(key, input);
        if (result.rejected.length > 0) this.opts.onRejected?.(result.rejected);
        this.opts.onSaved?.(result);
      } catch (err) {
        // put the values back, unless a newer one has been entered meanwhile
        for (const [key, input] of batch) if (!this.pending.has(key)) this.pending.set(key, input);
        for (const part of confirmed) this.confirms.add(part);
        this.failures++;
        if (this.opts.isRetryable(err)) {
          this.setState(this.opts.isOffline?.(err) ? "offline" : "error");
          const delays = this.opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS;
          this.schedule(delays[Math.min(this.failures - 1, delays.length - 1)]);
        } else {
          this.setState("error");
          this.opts.onFailure?.(err);
        }
        return;
      }
    }
    if (!this.disposed && this.pending.size === 0 && this.confirms.size === 0) this.setState("saved");
  }
}
