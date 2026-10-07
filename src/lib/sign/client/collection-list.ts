// ============================================================
// Doc Sign, browser side: the ONE ordered list a document collection is built from. Files of the sender's own and templates sit in the same
// list, in the order they will be signed; the sender adds many files at once (or one at a time), ticks templates, reorders and removes, and
// the list becomes the request that makes the documents. Pure functions over plain data (no React, no network), so the rules (six at most,
// what is skipped and why, the order sent) are tested without a screen.
// ============================================================

import { ENVELOPE_MAX_DOCUMENTS, ENVELOPE_MIN_DOCUMENTS, type OrderEntry } from "@/lib/sign/envelopes";

import { checkUploadFile, titleFromFileName } from "./upload";

/** All the files of one request together: the server refuses more (60 MB). */
export const MAX_COLLECTION_BYTES = 60 * 1024 * 1024;

export interface FileLike {
  name: string;
  size: number;
}

export type CollectionItem<F extends FileLike = File> =
  | { key: string; kind: "file"; file: F; title: string }
  | { key: string; kind: "template"; id: string; name: string; title: string };

let counter = 0;
const nextKey = (): string => `item${++counter}`;

/** What the document is called when the sender has typed no title of their own: the file's name without its extension, or the template's name. */
export const defaultTitle = (item: CollectionItem<FileLike>): string => (item.kind === "file" ? titleFromFileName(item.file.name) : item.name);

/** What the document is called in the list: the sender's title, else the default. */
export const shownTitle = (item: CollectionItem<FileLike>): string => item.title.trim() || defaultTitle(item);

export interface RejectedFile {
  name: string;
  /** The failure code (worded by `Sign.send.errors.<code>`). */
  code: "upload_empty" | "upload_too_large" | "upload_unsupported" | "uploads_too_large";
}

export interface AddFilesResult<F extends FileLike> {
  items: CollectionItem<F>[];
  /** How many were added. */
  added: number;
  /** Files that cannot be used, each with why (a wrong type, empty, over 25 MB, or over the total of 60 MB). */
  rejected: RejectedFile[];
  /** Files that were fine but did not fit in the six. */
  overflow: number;
}

const filesBytes = (items: readonly CollectionItem<FileLike>[]): number => items.reduce((n, i) => n + (i.kind === "file" ? i.file.size : 0), 0);

/**
 * Add files to the end of the list, in the order they were chosen, up to `max` documents in all. A file that cannot be used is named and left
 * out; a file that is fine but does not fit is counted in `overflow` (what fits is still added). The files of one request add up to 60 MB.
 */
export function addFiles<F extends FileLike>(items: readonly CollectionItem<F>[], files: readonly F[], max: number = ENVELOPE_MAX_DOCUMENTS): AddFilesResult<F> {
  const next = [...items];
  const rejected: RejectedFile[] = [];
  let added = 0;
  let overflow = 0;
  let bytes = filesBytes(next);
  for (const file of files) {
    const problem = checkUploadFile(file);
    if (problem) {
      rejected.push({ name: file.name, code: problem });
      continue;
    }
    if (next.length >= max) {
      overflow++;
      continue;
    }
    if (bytes + file.size > MAX_COLLECTION_BYTES) {
      rejected.push({ name: file.name, code: "uploads_too_large" });
      continue;
    }
    bytes += file.size;
    next.push({ key: nextKey(), kind: "file", file, title: "" });
    added++;
  }
  return { items: next, added, rejected, overflow };
}

/** Tick a template: it goes to the end of the list; ticking it again takes it out. Nothing is added when the list is full (`full`). */
export function toggleTemplate<F extends FileLike>(items: readonly CollectionItem<F>[], template: { id: string; name: string }, max: number = ENVELOPE_MAX_DOCUMENTS): { items: CollectionItem<F>[]; full: boolean } {
  if (items.some((i) => i.kind === "template" && i.id === template.id)) return { items: items.filter((i) => !(i.kind === "template" && i.id === template.id)), full: false };
  if (items.length >= max) return { items: [...items], full: true };
  return { items: [...items, { key: nextKey(), kind: "template", id: template.id, name: template.name, title: "" }], full: false };
}

export const hasTemplate = (items: readonly CollectionItem<FileLike>[], id: string): boolean => items.some((i) => i.kind === "template" && i.id === id);

/** Move the item at `from` to the place `to` (both clamped to the list); a copy. */
export function moveTo<T>(list: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= list.length) return [...list];
  const target = Math.max(0, Math.min(list.length - 1, to));
  if (target === from) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

/** Move the item at `index` by `delta` places (up is negative); a copy. */
export const moveBy = <T>(list: readonly T[], index: number, delta: number): T[] => moveTo(list, index, index + delta);

export const removeItem = <F extends FileLike>(items: readonly CollectionItem<F>[], key: string): CollectionItem<F>[] => items.filter((i) => i.key !== key);

/** Give a document a title of the sender's own (an empty one goes back to the default). */
export const retitle = <F extends FileLike>(items: readonly CollectionItem<F>[], key: string, title: string): CollectionItem<F>[] => items.map((i) => (i.key === key ? { ...i, title } : i));

/** Is the list the size a collection needs (two to six)? */
export const sizeOk = (count: number): boolean => count >= ENVELOPE_MIN_DOCUMENTS && count <= ENVELOPE_MAX_DOCUMENTS;

/** The order the server is sent: a file by its place among the files sent (in the order they appear here), a template by its id. */
export function orderPayload<F extends FileLike>(items: readonly CollectionItem<F>[]): { order: OrderEntry[]; files: F[] } {
  const files: F[] = [];
  const order: OrderEntry[] = items.map((i) => {
    const title = i.title.trim() ? { title: i.title.trim().slice(0, 200) } : {};
    if (i.kind === "file") {
      files.push(i.file);
      return { kind: "file", index: files.length - 1, ...title };
    }
    return { kind: "template", id: i.id, ...title };
  });
  return { order, files };
}

/**
 * The request that makes the documents of the list: multipart (every file as a `file` part, then `order`, then the other fields) when there
 * is a file, JSON when there are only templates. `extra` is the title, contact, ticket and deal; empty values are left out.
 */
export function collectionRequest(items: readonly CollectionItem<File>[], extra: Record<string, string | null | undefined> = {}): { form: FormData } | { json: Record<string, unknown> } {
  const { order, files } = orderPayload(items);
  const fields = Object.fromEntries(Object.entries(extra).filter(([, v]) => typeof v === "string" && v !== "")) as Record<string, string>;
  if (files.length === 0) return { json: { order, ...fields } };
  const form = new FormData();
  for (const f of files) form.append("file", f, f.name);
  form.append("order", JSON.stringify(order));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  return { form };
}
