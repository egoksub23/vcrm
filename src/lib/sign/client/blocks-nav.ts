// ============================================================
// Secure Sign, step 3 (the signature blocks) as ONE continuous scroll over every page of every document: the arithmetic of it, as pure functions
// over plain data (no React, no DOM), so it is tested without a screen.
//
//   - where each page is (a "slot": measured in the scroll container's pixels) and which document and page the reader is on,
//   - where to scroll to for a document, a page or a block,
//   - which documents' files are open in the browser (near the screen, never all of them),
//   - how much each person has across the documents, from the blocks as they are on screen right now,
//   - where the step is told to land (`?doc=`, a Fix button that names a document, and a block).
// ============================================================

import type { PlacedField } from "../pdf/types";
import { isSigner, type EnvelopePerson } from "../envelopes";
import { pageAtOffset } from "./editor-pages";
import { documentCover, typedPeople, type DocCover, type ProcessDoc } from "./process";

/** One thing in the scroll that can be the current one: a page of a document, or the card that stands for a document with no pages. */
export interface Slot {
  /** Index of the document in the collection's order. */
  doc: number;
  /** Index of the page in its document (0 for a card). */
  page: number;
  /** Distance from the top of the scroll content, in pixels. */
  top: number;
  height: number;
  /** A document with nothing printed (a form only): a card, not a page. */
  card?: boolean;
}

export interface Position {
  doc: number;
  page: number;
}

/** Slots in the order they appear (top to bottom). */
export function sortSlots(slots: readonly Slot[]): Slot[] {
  return [...slots].sort((a, b) => a.top - b.top);
}

/** The document and page the reader is on: the slot covering the middle of the visible part, or the nearest one when the middle falls between two. */
export function positionAt(slots: readonly Slot[], scrollTop: number, viewport: number): Position {
  if (slots.length === 0) return { doc: 0, page: 0 };
  const i = pageAtOffset(
    slots.map((s) => s.top),
    slots.map((s) => s.height),
    scrollTop,
    viewport,
  );
  const s = slots[i];
  return { doc: s.doc, page: s.page };
}

/** The slot of a page; the first slot of the document when the page is not there (a document not measured yet); undefined for a document with none. */
export function slotFor(slots: readonly Slot[], doc: number, page = 0): Slot | undefined {
  return slots.find((s) => s.doc === doc && s.page === page) ?? slots.find((s) => s.doc === doc);
}

export interface JumpOptions {
  /** Height of the visible part of the scroll. */
  viewport: number;
  /** Room kept above the page: the document's header sticks to the top, so a page lands below it. */
  offset?: number;
  /** A place on the page (0 to 1 down it) to bring into view, one third down the screen; without it the page's top lands under the header. */
  y?: number;
}

/** The scroll position that shows a slot. */
export function jumpTop(slot: Slot, { viewport, offset = 60, y }: JumpOptions): number {
  if (y !== undefined && y > 0) return Math.max(0, Math.round(slot.top + y * slot.height - viewport / 3));
  return Math.max(0, Math.round(slot.top - offset));
}

/** Where, as a fraction down the slot (0 to 1), the middle of the visible part is. */
export function middleOf(slot: Slot, scrollTop: number, viewport: number): number {
  return (scrollTop + viewport / 2 - slot.top) / Math.max(1, slot.height);
}

/**
 * The page a new block goes on: the page in the middle of the screen, or the nearest page when the middle is on a card (a document with no
 * pages) or between documents. Null when there is no page anywhere.
 */
export function pageSlotNear(slots: readonly Slot[], scrollTop: number, viewport: number): Slot | null {
  const pages = slots.filter((s) => !s.card);
  if (pages.length === 0) return null;
  const mid = scrollTop + viewport / 2;
  let best = pages[0];
  let bestDistance = Infinity;
  for (const s of pages) {
    const d = mid < s.top ? s.top - mid : mid > s.top + s.height ? mid - (s.top + s.height) : 0;
    if (d < bestDistance) {
      best = s;
      bestDistance = d;
    }
  }
  return best;
}

// ---- how much the screen can do -----------------------------------------------------------------------------------------

export type EditorLayout = "desktop" | "tablet" | "phone";

/** The width of the editor decides how much it can do: three columns; a scroll with slide-over columns; or only looking (a phone). Unmeasured is desktop. */
export const layoutFor = (width: number): EditorLayout => (width <= 0 || width >= 1040 ? "desktop" : width >= 640 ? "tablet" : "phone");

// ---- which files are open ---------------------------------------------------------------------------------------

export interface DocRange {
  top: number;
  bottom: number;
}

/** The documents whose area touches the visible part widened by `margin` pixels on each side. */
export function docsNear(ranges: readonly DocRange[], scrollTop: number, viewport: number, margin: number): number[] {
  const lo = scrollTop - margin;
  const hi = scrollTop + viewport + margin;
  const out: number[] = [];
  ranges.forEach((r, i) => {
    if (r.bottom >= lo && r.top <= hi) out.push(i);
  });
  return out;
}

/**
 * The documents whose files should be open: every one on the screen (without it the reader sees a blank page), then the nearest of those just
 * off the screen, never more than `max` in all unless more than that are on the screen. `ranges` are the documents' areas in the scroll.
 */
export function livePdfs(args: { ranges: readonly DocRange[]; scrollTop: number; viewport: number; margin: number; current: number; max: number; pinned?: readonly number[] }): number[] {
  const { ranges, scrollTop, viewport, margin, current, max } = args;
  const visible = docsNear(ranges, scrollTop, viewport, 0);
  const wanted = new Set<number>([...(args.pinned ?? []), ...visible]);
  const rest = docsNear(ranges, scrollTop, viewport, margin)
    .filter((i) => !wanted.has(i))
    .sort((a, b) => Math.abs(a - current) - Math.abs(b - current) || a - b);
  for (const i of rest) {
    if (wanted.size >= max) break;
    wanted.add(i);
  }
  return [...wanted].sort((a, b) => a - b);
}

// ---- heights before a file is open -------------------------------------------------------------------------------------

/** Height of a page of an A4 sheet over its width: used for a document whose file has not been opened yet (the real sizes replace it once it is). */
export const ESTIMATED_ASPECT = 1.4142;

/** The pages of a document as sizes: the real ones when its file has been read, else `count` pages of the usual shape. */
export function pageSizesOf(known: readonly { width: number; height: number }[] | undefined, count: number | null): { width: number; height: number }[] {
  if (known && known.length > 0) return [...known];
  return Array.from({ length: Math.max(1, count ?? 1) }, () => ({ width: 595, height: Math.round(595 * ESTIMATED_ASPECT) }));
}

// ---- who has what ------------------------------------------------------------------------------------------------------

const isBlock = (f: PlacedField): boolean => f.type === "signature" || f.type === "initials";

/** A document as the steps read it, with its block counts replaced by the blocks as they are on the screen now (the server's follow a moment after each save). */
export function liveDoc(doc: ProcessDoc, fields: readonly PlacedField[] | null | undefined): ProcessDoc {
  if (!fields) return doc;
  const signatureCounts: Record<string, number> = {};
  const fieldCounts: Record<string, number> = {};
  for (const r of doc.roles) {
    signatureCounts[r.key] = 0;
    fieldCounts[r.key] = 0;
  }
  for (const f of fields) {
    if (f.role in fieldCounts) fieldCounts[f.role] += 1;
    if (f.role in signatureCounts && isBlock(f)) signatureCounts[f.role] += 1;
  }
  return { ...doc, signatureCounts, fieldCounts };
}

/** The role of a field's person on a document, the other way round: which person a block belongs to (null for the sender's, or a role nobody holds). */
export function personOfRole(people: readonly EnvelopePerson[], doc: Pick<ProcessDoc, "id" | "fromTemplate">, roleKey: string): string | null {
  for (const p of typedPeople(people).filter(isSigner)) {
    const role = doc.fromTemplate ? (p.roles[doc.id] ?? "") : p.key;
    if (role && role === roleKey) return p.key;
  }
  return null;
}

export interface PersonCoverage {
  key: string;
  name: string;
  color: number;
  /** Signature blocks of theirs over all the documents. */
  blocks: number;
  /** The documents they are on (an uploaded file gives every person a place; a template's roles are matched). */
  of: number;
  /** The documents they have a block on. */
  on: number;
  /** A block on every document they are on. */
  complete: boolean;
}

/** For each person who must sign: on how many of their documents they have a block. */
export function coverageByPerson(covers: readonly DocCover[], people: readonly EnvelopePerson[]): PersonCoverage[] {
  return typedPeople(people)
    .filter(isSigner)
    .map((p, i) => {
      const mine = covers.flatMap((c) => c.people.filter((x) => x.key === p.key));
      const color = mine[0]?.color ?? i % 6;
      return {
        key: p.key,
        name: p.fullName.trim(),
        color,
        blocks: mine.reduce((n, x) => n + x.blocks, 0),
        of: mine.length,
        on: mine.filter((x) => x.covered).length,
        complete: mine.length > 0 && mine.every((x) => x.covered),
      };
    });
}

/** The covers of the documents, with the blocks as they are on the screen (`fieldsOf` returns undefined for a document not read yet). */
export function liveCovers(docs: readonly ProcessDoc[], people: readonly EnvelopePerson[], fieldsOf: (id: string) => readonly PlacedField[] | null | undefined): DocCover[] {
  return docs.map((d) => documentCover(liveDoc(d, fieldsOf(d.id)), people));
}

/** The people who must sign who have no block on a document they are on (the navigator marks the document). */
export const peopleWithoutBlock = (cover: DocCover): string[] => (cover.formOnly ? [] : cover.people.filter((p) => !p.covered).map((p) => p.key));

// ---- where the step lands ----------------------------------------------------------------------------------------------

export interface Landing {
  doc: number;
  page: number;
  /** How far down the page the block is (0 to 1). */
  y: number;
  /** The block to select, when one was asked for and found. */
  key: string | null;
}

/**
 * Where the step opens: on the document in `?doc=` (or a Fix button that names one), and on the block it names when there is one. Null when no
 * document was asked for or it is not in the collection (the step opens at the top). `fieldsOf` returns undefined while a document is still being
 * read: a named block cannot be found yet, so `settled` is false and the caller asks again once it is.
 */
export function landingFor(asked: { doc?: string | null; block?: string | null }, ids: readonly string[], fieldsOf: (id: string) => readonly PlacedField[] | null | undefined): { landing: Landing; settled: boolean } | null {
  if (!asked.doc) return null;
  const doc = ids.indexOf(asked.doc);
  if (doc < 0) return null;
  if (!asked.block) return { landing: { doc, page: 0, y: 0, key: null }, settled: true };
  const fields = fieldsOf(asked.doc);
  if (!fields) return { landing: { doc, page: 0, y: 0, key: null }, settled: false };
  const f = fields.find((x) => x.key === asked.block);
  return f ? { landing: { doc, page: f.page, y: f.y, key: f.key }, settled: true } : { landing: { doc, page: 0, y: 0, key: null }, settled: true };
}
