"use client";

// ============================================================
// Secure Sign, step 3: the signature blocks of ALL the documents of a process in one editor. A document on its own is a collection of one.
//
//   - CENTRE: one continuous scroll of every page of every document, each document under a slim header that sticks while its pages are in view.
//   - LEFT: who a new block is for, the quick "Add a signature block for <name>" buttons, the field types, the properties of the selected block,
//     and (collapsible) the blocks, the problems and the roles of the document in view.
//   - RIGHT: the document navigator: every document, the one in view open with its pages; a click goes there. On a phone a "Jump to document" menu.
//
// Each document keeps its own editing model (`useEditorModel`, one per document, in its part of the scroll) and its own save queue (the SaveHub);
// this component holds what they share: what is selected, the armed tool, who new blocks are for, the zoom, and the scroll's arithmetic.
//
// Undo and redo are per document: they act on the document that holds the selected block (the document in view when nothing is selected).
// Delete, copy, paste, duplicate, the arrows and Esc act on the selected block's document in the same way.
// ============================================================

import { PanelLeft, PanelRight, Smartphone } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { toast } from "sonner";

import { EditorToolbar } from "@/components/sign/editor/editor-toolbar";
import { FieldsList } from "@/components/sign/editor/fields-list";
import { IssuesPanel } from "@/components/sign/editor/issues-panel";
import { PropertiesPanel, type FieldChange } from "@/components/sign/editor/properties-panel";
import { RoleEmailsProvider } from "@/components/sign/editor/role-emails";
import { RolesPanel } from "@/components/sign/editor/roles-panel";
import { SaveStatus } from "@/components/sign/editor/save-status";
import { useStableCallback, type EditorModel } from "@/components/sign/editor/use-editor-model";
import type { PdfPageSize } from "@/components/sign/pdf-pages";
import { Button } from "@/components/ui/button";
import { useCapability } from "@/hooks/use-can";
import { coverageByPerson, jumpTop, landingFor, layoutFor, type EditorLayout, liveCovers, livePdfs, middleOf, pageSlotNear, personOfRole, positionAt, slotFor, type DocRange, type Position, type Slot } from "@/lib/sign/client/blocks-nav";
import { percentOfWidth, pageWidthPx, type Zoom } from "@/lib/sign/client/editor-pages";
import { mergeKeysOf, signatureRectFor, type Rect } from "@/lib/sign/client/layout";
import { personColor, roleKeyOn, typedPeople } from "@/lib/sign/client/process";
import { isSigner } from "@/lib/sign/envelopes";
import { FIELD_TYPES, type FieldType, type PlacedField } from "@/lib/sign/pdf/types";
import { MAX_FIELDS } from "@/lib/sign/rules";
import type { SignLocale, SignRole } from "@/lib/sign/types";

import type { Process } from "../process/use-process";
import { CoverageSummary } from "./coverage-summary";
import { DocJumpSelect, DocNavigator } from "./doc-navigator";
import { DocSection, type SectionCtl, type SectionEnv } from "./doc-section";
import { PersonSelector, ToolPalette, type PersonRow } from "./tools-column";
import { blockedBy, docIssues, docLocked, useBlocksData, type BlocksLoad } from "./use-blocks-data";

const PAD = 16;
const LOADING: BlocksLoad = { status: "loading" };
/** How far from the screen (in pixels) a document's file is opened, and how many files are open at most (those on the screen always are). */
const OPEN_MARGIN = 1600;
const MAX_OPEN = 3;
/** How long after a jump the position is kept while the pages below it find their real heights. */
const SETTLE_MS = 6000;

function useWidthOf(el: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const update = () => setWidth(Math.floor(el.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return width;
}

const sameList = (a: readonly number[], b: readonly number[]): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const sameSizes = (a: readonly PdfPageSize[] | undefined, b: readonly PdfPageSize[]): boolean => !!a && a.length === b.length && a.every((p, i) => p.width === b[i].width && p.height === b[i].height);

interface Selected {
  docId: string;
  key: string;
}

export function BlocksEditor({ process }: { process: Process }) {
  const t = useTranslations("Sign.process.multi");
  const te = useTranslations("Sign.editor");
  const tp = useTranslations("Sign.send.envelope.people");
  const locale = useLocale();
  const labelLocale = (["en", "ms", "zh", "ko"].includes(locale) ? locale : "en") as SignLocale;
  const canTemplates = useCapability("sign.templates");
  const { docs, people, canSend } = process;
  const docIds = useMemo(() => docs.map((d) => d.id), [docs]);

  const data = useBlocksData({ docIds, onSaved: process.refresh });
  // leaving the step saves every document first
  useEffect(() => {
    process.editorFlush.current = data.flush;
    return () => {
      process.editorFlush.current = null;
    };
  });

  // ---- the screen ----------------------------------------------------------------------------------------------------
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  const rootWidth = useWidthOf(root);
  const scrollWidth = useWidthOf(scrollEl);
  const layout: EditorLayout = layoutFor(rootWidth);
  const phone = layout === "phone";
  const [leftOpen, setLeftOpen] = useState(false);
  const [rightOpen, setRightOpen] = useState(false);

  // ---- what the editor holds -----------------------------------------------------------------------------------------
  const [selected, setSelected] = useState<Selected | null>(null);
  const [tool, setTool] = useState<FieldType | null>(null);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [preview, setPreview] = useState(false);
  const [position, setPosition] = useState<Position>({ doc: 0, page: 0 });
  const [active, setActive] = useState<number[]>([0]);
  const [sizes, setSizes] = useState<Record<string, PdfPageSize[]>>({});
  const [opened, setOpened] = useState<Record<string, PDFDocumentProxy>>({});
  const [hist, setHist] = useState<Record<string, { canUndo: boolean; canRedo: boolean }>>({});
  const [unlocked, setUnlocked] = useState<Record<string, boolean>>({});
  const models = useRef<Record<string, EditorModel>>({});
  const loadsRef = useRef(data.loads);
  const selectedRef = useRef(selected);
  const positionRef = useRef(position);
  useEffect(() => {
    loadsRef.current = data.loads;
    selectedRef.current = selected;
    positionRef.current = position;
  });

  const ready = (id: string) => {
    const l = data.loads[id];
    return l && l.status === "ready" ? l.data : null;
  };

  // ---- the people: who the blocks are for ---------------------------------------------------------------------------------------
  const signers = useMemo(() => typedPeople(people).filter(isSigner), [people]);
  const activePerson = signers.find((p) => p.key === activeKey) ?? signers[0] ?? null;
  const covers = useMemo(() => liveCovers(docs, people, data.fieldsOf), [docs, people, data.fieldsOf]);
  const coverage = useMemo(() => coverageByPerson(covers, people), [covers, people]);
  // the address and the colour of each person by the role they hold on each document: two people with one name are told apart, one person has one colour everywhere
  const perDoc = useMemo(() => {
    const out: Record<string, { colors: Record<string, number>; emails: Record<string, string> }> = {};
    for (const d of docs) {
      const colors: Record<string, number> = {};
      const emails: Record<string, string> = {};
      for (const p of signers) {
        const key = roleKeyOn(p, d);
        if (!key) continue;
        colors[key] = personColor(people, p.key);
        if (p.email.trim()) emails[key] = p.email.trim();
      }
      out[d.id] = { colors, emails };
    }
    return out;
  }, [docs, people, signers]);
  const coloredRoles = useMemo(() => {
    const out: Record<string, SignRole[]> = {};
    for (const d of docs) {
      const data1 = data.loads[d.id];
      if (!data1 || data1.status !== "ready") continue;
      const colors = perDoc[d.id]?.colors ?? {};
      out[d.id] = data1.data.roles.map((r) => (colors[r.key] === undefined || colors[r.key] === r.color ? r : { ...r, color: colors[r.key] }));
    }
    return out;
  }, [docs, data.loads, perDoc]);

  const roleOn = (personKey: string, docId: string): string => {
    const p = signers.find((x) => x.key === personKey);
    const d = docs.find((x) => x.id === docId);
    return p && d ? roleKeyOn(p, d) : "";
  };

  // ---- the arithmetic of the scroll -----------------------------------------------------------------------------------------
  const firstWidth = sizes[docIds[0]]?.[0]?.width ?? 595;
  const pageWidth = pageWidthPx(zoom, firstWidth, scrollWidth - PAD * 2);
  const fitPercent = percentOfWidth(pageWidth, firstWidth);

  const measure = useCallback((): { slots: Slot[]; ranges: DocRange[] } | null => {
    if (!scrollEl) return null;
    const base = scrollEl.getBoundingClientRect().top - scrollEl.scrollTop;
    const slots: Slot[] = [];
    const ranges: DocRange[] = docIds.map(() => ({ top: Infinity, bottom: -Infinity }));
    scrollEl.querySelectorAll<HTMLElement>("[data-doc-index]").forEach((section) => {
      const doc = Number(section.dataset.docIndex);
      const sr = section.getBoundingClientRect();
      ranges[doc] = { top: sr.top - base, bottom: sr.bottom - base };
      section.querySelectorAll<HTMLElement>("[data-page]").forEach((pg) => {
        const r = pg.getBoundingClientRect();
        slots.push({ doc, page: Number(pg.dataset.page), top: r.top - base, height: r.height });
      });
      const card = section.querySelector<HTMLElement>("[data-card]");
      if (card) {
        const r = card.getBoundingClientRect();
        slots.push({ doc, page: 0, top: r.top - base, height: r.height, card: true });
      }
    });
    return { slots, ranges };
  }, [scrollEl, docIds]);

  const settle = useRef<{ doc: number; page: number | null; y?: number; until: number } | null>(null);
  const pinned = useRef<number[]>([]);
  const anchor = useRef<{ doc: number; page: number; offset: number } | null>(null);

  const update = useStableCallback((layoutChanged: boolean) => {
    const el = scrollEl;
    if (!el || el.clientHeight === 0) return;
    const m = measure();
    if (!m || m.slots.length === 0) return;
    let s = settle.current;
    if (s && Date.now() > s.until) {
      settle.current = null;
      pinned.current = [];
      s = null;
    }
    if (layoutChanged) {
      if (s) {
        // just jumped: the pages found their real heights, so the destination moved; stay on it until the reader scrolls for themselves
        const slot = slotFor(m.slots, s.doc, s.page ?? 0);
        if (slot) {
          const top = jumpTop(slot, { viewport: el.clientHeight, y: s.y });
          if (Math.abs(el.scrollTop - top) > 2) el.scrollTop = top;
        }
      } else if (anchor.current) {
        // something above the screen changed height: keep what the reader looks at where it was
        const a = anchor.current;
        const slot = m.slots.find((x) => x.doc === a.doc && x.page === a.page);
        if (slot) {
          const delta = slot.top - el.scrollTop - a.offset;
          if (Math.abs(delta) > 1) el.scrollTop += delta;
        }
      }
    }
    const pos = positionAt(m.slots, el.scrollTop, el.clientHeight);
    const at = slotFor(m.slots, pos.doc, pos.page);
    if (at) anchor.current = { doc: pos.doc, page: pos.page, offset: at.top - el.scrollTop };
    setPosition((prev) => (prev.doc === pos.doc && prev.page === pos.page ? prev : pos));
    const live = livePdfs({ ranges: m.ranges, scrollTop: el.scrollTop, viewport: el.clientHeight, margin: OPEN_MARGIN, current: pos.doc, max: MAX_OPEN, pinned: pinned.current });
    setActive((prev) => (sameList(prev, live) ? prev : live));
  });

  const frame = useRef(0);
  const layoutWanted = useRef(false);
  const schedule = useStableCallback((layoutChanged: boolean) => {
    if (layoutChanged) layoutWanted.current = true;
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const l = layoutWanted.current;
      layoutWanted.current = false;
      update(l);
    });
  });
  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );
  useEffect(() => {
    if (!contentEl || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => schedule(true));
    ro.observe(contentEl);
    schedule(true);
    return () => ro.disconnect();
  }, [contentEl, schedule]);

  const stopSettling = () => {
    settle.current = null;
    pinned.current = [];
  };

  /** Scroll to a document (its first page), a page, or a place on a page. */
  const jumpTo = useStableCallback((doc: number, page: number | null, y?: number, smooth = false) => {
    const el = scrollEl;
    const m = measure();
    if (!el || !m) return;
    const slot = slotFor(m.slots, doc, page ?? 0);
    if (!slot) return;
    el.scrollTo({ top: jumpTop(slot, { viewport: el.clientHeight, y }), behavior: smooth ? "smooth" : "auto" });
    setPosition({ doc, page: slot.page });
    // a file that is not open yet has estimated pages: keep the destination while it opens and finds the real heights
    if (!sizes[docIds[doc]] && !smooth) {
      settle.current = { doc, page, y, until: Date.now() + SETTLE_MS };
      pinned.current = [doc];
      schedule(false);
    }
  });

  // ---- where the step opens: ?doc=, and a Fix button's document and block ---------------------------------------------------
  const landed = useRef(-1);
  const nonce = process.landingNonce ?? 0;
  const allRead = docIds.length > 0 && docIds.every((id) => data.loads[id] && data.loads[id].status !== "loading");
  useEffect(() => {
    if (landed.current === nonce) return;
    const asked = { doc: process.openDocId, block: process.openBlockKey ?? null };
    if (!asked.doc) {
      landed.current = nonce;
      return;
    }
    if (!scrollEl || scrollWidth <= 0 || !allRead) return;
    const res = landingFor(asked, docIds, (id) => (data.loads[id]?.status === "error" ? [] : data.fieldsOf(id)));
    if (!res) {
      landed.current = nonce;
      return;
    }
    landed.current = nonce;
    jumpTo(res.landing.doc, res.landing.page, res.landing.y > 0 ? res.landing.y : undefined, false);
    if (res.landing.key) {
      setSelected({ docId: docIds[res.landing.doc], key: res.landing.key });
      const f = data.fieldsOf(docIds[res.landing.doc])?.find((x) => x.key === res.landing.key);
      if (f && f.role !== "sender") {
        const owner = personOfRole(people, docs[res.landing.doc], f.role);
        if (owner) setActiveKey(owner);
      }
    }
  }, [nonce, process.openDocId, process.openBlockKey, scrollEl, scrollWidth, allRead, docIds, data, docs, people, jumpTo]);

  // ---- placing, selecting ---------------------------------------------------------------------------------------------------
  const focusField = (docId: string, key: string) => {
    requestAnimationFrame(() => root?.querySelector<HTMLElement>(`[data-doc-id="${docId}"] [data-field="${key}"]`)?.focus({ preventScroll: true }));
  };

  const select = useStableCallback((docId: string, key: string | null) => {
    setSelected(key ? { docId, key } : null);
    if (!key) return;
    const f = data.fieldsOf(docId)?.find((x) => x.key === key);
    const d = docs.find((x) => x.id === docId);
    if (f && d && f.role !== "sender") {
      const owner = personOfRole(people, d, f.role);
      if (owner) setActiveKey(owner);
    }
  });

  const place = useStableCallback((docId: string, type: FieldType, page: number, rect: Rect, keepTool: boolean) => {
    const model = models.current[docId];
    if (!model) return;
    const key = model.place({ type, page, rect, preferredRole: activePerson ? roleOn(activePerson.key, docId) || null : null });
    if (!key) return;
    setSelected({ docId, key });
    if (!keepTool) setTool(null);
    focusField(docId, key);
  });

  /** The document at this index can have blocks placed on it now. */
  const editable = (docId: string): boolean => {
    const d = ready(docId);
    return !!d && d.hasFile && !d.formOnly && !docLocked(d, { phone, canSend }, !!unlocked[docId]);
  };

  const addSignatureFor = (personKey: string) => {
    if (!scrollEl) return;
    const m = measure();
    if (!m) return;
    const slot = pageSlotNear(m.slots, scrollEl.scrollTop, scrollEl.clientHeight);
    if (!slot) return;
    const docId = docIds[slot.doc];
    const d = ready(docId);
    const model = models.current[docId];
    const role = roleOn(personKey, docId);
    if (!d || !model || !role || !editable(docId) || d.fields.length >= MAX_FIELDS) return;
    const size = sizes[docId]?.[slot.page];
    const aspect = size ? size.height / size.width : slot.height / Math.max(1, pageWidth);
    const rect = signatureRectFor(d.fields, slot.page, aspect, middleOf(slot, scrollEl.scrollTop, scrollEl.clientHeight));
    const key = model.place({ type: "signature", page: slot.page, rect, preferredRole: role });
    if (!key) return;
    setActiveKey(personKey);
    setSelected({ docId, key });
    focusField(docId, key);
  };

  /** Select a block (from a list) and bring it into view. */
  const reveal = (docId: string, key: string) => {
    const f = data.fieldsOf(docId)?.find((x) => x.key === key);
    const i = docIds.indexOf(docId);
    select(docId, key);
    if (f && i >= 0) jumpTo(i, f.page, f.y > 0 ? f.y : undefined, true);
    if (layout === "tablet") setLeftOpen(false);
  };

  // ---- the controller the documents' parts talk to -------------------------------------------------------------------------------
  const ctl = useMemo<SectionCtl>(
    () => ({
      register: (docId, model) => {
        if (model) models.current[docId] = model;
        else delete models.current[docId];
      },
      history: (docId, canUndo, canRedo) => setHist((prev) => (prev[docId]?.canUndo === canUndo && prev[docId]?.canRedo === canRedo ? prev : { ...prev, [docId]: { canUndo, canRedo } })),
      opened: (docId, open) => {
        if (open) setSizes((prev) => (sameSizes(prev[docId], open.pages) ? prev : { ...prev, [docId]: open.pages }));
        setOpened((prev) => {
          if (open ? prev[docId] === open.doc : !(docId in prev)) return prev;
          const next = { ...prev };
          if (open) next[docId] = open.doc;
          else delete next[docId];
          return next;
        });
      },
      layout: (docId, next) => data.setLayout(docId, next),
      value: (docId, key, value) => data.setValue(docId, key, value),
      select: (docId, key) => select(docId, key),
      place: (docId, type, page, rect, keep) => place(docId, type, page, rect, keep),
      toggleUnlock: (docId) => setUnlocked((prev) => ({ ...prev, [docId]: !prev[docId] })),
      reload: (docId, replaced) => data.reload(docId, replaced),
      flush: (docId) => data.flushDoc(docId),
      changed: () => process.refresh(),
    }),
    // every function below is stable (callbacks of the data hook, state setters, stable wrappers)
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.setLayout, data.setValue, data.reload, data.flushDoc, select, place],
  );
  const env = useMemo<SectionEnv>(() => ({ pageWidth, scrollRoot: scrollEl, tool: phone || !canSend ? null : tool, preview, phone, canSend, canTemplates, ctl }), [pageWidth, scrollEl, tool, preview, phone, canSend, canTemplates, ctl]);

  // ---- the document the keyboard acts on ----------------------------------------------------------------------------------------
  const currentDocId = docIds[position.doc] ?? docIds[0];
  const targetDocId = selected?.docId ?? currentDocId;
  const selectedField: PlacedField | null = useMemo(() => (selected ? (data.fieldsOf(selected.docId)?.find((f) => f.key === selected.key) ?? null) : null), [selected, data]);
  const targetModel = () => models.current[targetDocId];

  const deleteSelected = () => {
    if (!selected || !selectedField) return;
    models.current[selected.docId]?.remove([selected.key]);
    setSelected(null);
    scrollEl?.focus({ preventScroll: true });
  };
  const duplicateSelected = () => {
    if (!selected || !selectedField) return;
    const key = models.current[selected.docId]?.duplicate(selected.key);
    if (key) {
      setSelected({ docId: selected.docId, key });
      focusField(selected.docId, key);
    }
  };
  const copySelectedToPages = () => {
    if (!selected || !selectedField) return;
    const count = sizes[selected.docId]?.length || docs.find((d) => d.id === selected.docId)?.pageCount || 1;
    const r = models.current[selected.docId]?.copyToEveryPage(selected.key, count);
    if (r) toast.success(r.added > 0 ? te("props.copiedToPages", { count: r.added }) : te("props.copiedNone"));
  };

  const locked = phone || !canSend;
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const inForm = !!target.closest("input, textarea, select, [contenteditable='true']");
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (!locked && !inForm && mod && key === "z") {
      e.preventDefault();
      if (e.shiftKey) targetModel()?.redo();
      else targetModel()?.undo();
      return;
    }
    if (!locked && !inForm && mod && key === "y") {
      e.preventDefault();
      targetModel()?.redo();
      return;
    }
    if (inForm || locked) return;
    if (e.key === "Escape") {
      if (tool) setTool(null);
      else setSelected(null);
      return;
    }
    if (mod && key === "v") {
      e.preventDefault();
      const added = targetModel()?.paste(selected ? (selectedField?.page ?? 0) : position.page);
      if (added) {
        setSelected({ docId: targetDocId, key: added });
        focusField(targetDocId, added);
      }
      return;
    }
    if (!selected || !selectedField) return;
    const model = models.current[selected.docId];
    if (mod && key === "c") {
      e.preventDefault();
      model?.copy(selected.key);
    } else if (mod && key === "x") {
      e.preventDefault();
      model?.copy(selected.key);
      deleteSelected();
    } else if (mod && key === "d") {
      e.preventDefault();
      duplicateSelected();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      deleteSelected();
    } else if (target.closest("[data-field]") && e.key.startsWith("Arrow")) {
      e.preventDefault();
      const dir = e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : e.key === "ArrowUp" ? "up" : "down";
      const page = sizes[selected.docId]?.[selectedField.page];
      if (page) model?.nudge(selected.key, dir, e.shiftKey, page, e.altKey);
    }
  };

  // ---- the left column ----------------------------------------------------------------------------------------------------------
  const currentCover = covers[position.doc];
  const personName = (i: number) => tp("personN", { n: i + 1 });
  const currentEditable = !!currentDocId && editable(currentDocId);
  const rows: PersonRow[] = signers.map((p) => {
    const c = coverage.find((x) => x.key === p.key);
    const here = currentCover?.people.find((x) => x.key === p.key);
    return { key: p.key, name: p.fullName.trim(), email: p.email.trim(), color: c?.color ?? personColor(people, p.key), total: c?.blocks ?? 0, here: here?.blocks ?? 0, canAdd: !!here && currentEditable && (ready(currentDocId)?.fields.length ?? 0) < MAX_FIELDS };
  });
  const anyEditable = !locked && docIds.some((id) => editable(id));
  const full = (ready(targetDocId)?.fields.length ?? 0) >= MAX_FIELDS;

  const typeLabels = useMemo(() => Object.fromEntries(FIELD_TYPES.map((ty) => [ty, te(`types.${ty}`)])) as Record<FieldType, string>, [te]);
  const senderLabel = te("roles.sender");
  const selDoc = selected ? ready(selected.docId) : null;
  const selRoles = selected ? (coloredRoles[selected.docId] ?? []) : [];
  const selPages = selected ? sizes[selected.docId]?.length || docs.find((d) => d.id === selected.docId)?.pageCount || 1 : 1;
  const selLocked = selDoc && selected ? docLocked(selDoc, { phone, canSend }, !!unlocked[selected.docId]) : true;

  const viewDoc = ready(currentDocId);
  const viewRoles = coloredRoles[currentDocId] ?? [];
  const viewPages = sizes[currentDocId]?.length || docs[position.doc]?.pageCount || 1;
  const viewIssues = useMemo(() => (viewDoc ? docIssues(viewDoc, viewPages) : []), [viewDoc, viewPages]);
  const viewIssueKeys = useMemo(() => new Set(viewIssues.map((i) => i.field).filter((k): k is string => !!k)), [viewIssues]);
  const viewLocked = !viewDoc || docLocked(viewDoc, { phone, canSend }, !!unlocked[currentDocId]);
  const viewTitle = docs[position.doc]?.title ?? "";

  const leftColumn = (
    <RoleEmailsProvider value={perDoc[selected?.docId ?? currentDocId]?.emails ?? {}}>
      <div className="space-y-5 p-3" data-tools-column>
        <section aria-labelledby="blocks-who" className="space-y-2">
          <h3 id="blocks-who" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("whoHeading")}
          </h3>
          <PersonSelector people={rows} activeKey={activePerson?.key ?? null} onActive={setActiveKey} onAdd={(k) => addSignatureFor(k)} disabled={!anyEditable} personName={personName} />
        </section>
        <section aria-labelledby="blocks-fields" className="space-y-2">
          <h3 id="blocks-fields" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("fieldsHeading")}
          </h3>
          <ToolPalette tool={tool} onTool={setTool} disabled={!anyEditable} full={full} />
        </section>
        <section aria-labelledby="blocks-selected" className="space-y-1">
          <h3 id="blocks-selected" className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("selectedHeading")}
          </h3>
          <div className="-mx-3">
            <PropertiesPanel
              field={selectedField}
              fields={selDoc?.fields ?? []}
              roles={selRoles}
              readOnly={selLocked}
              typeLabels={typeLabels}
              mergeKeys={selDoc ? mergeKeysOf(selDoc.fields).map((m) => m.key) : []}
              pageCount={selPages}
              senderLabel={senderLabel}
              form={selDoc?.form}
              labelLocale={labelLocale}
              onChange={(change: FieldChange, coalesce?: string) => selected && models.current[selected.docId]?.update(selected.key, change, coalesce)}
              onDuplicate={duplicateSelected}
              onCopyToPages={copySelectedToPages}
              onDelete={deleteSelected}
            />
          </div>
        </section>
        {viewDoc ? (
          <div className="space-y-2" data-doc-lists>
            <p className="truncate text-xs text-muted-foreground">{t("listsFor", { title: viewTitle })}</p>
            <details className="rounded-lg border bg-background" data-list="fields">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t("blocksList", { count: viewDoc.fields.length })}</summary>
              <div className="border-t">
                <FieldsList fields={viewDoc.fields} roles={viewRoles} selectedKey={selected?.docId === currentDocId ? selected.key : null} issueKeys={viewIssueKeys} typeLabels={typeLabels} senderLabel={senderLabel} form={viewDoc.form} labelLocale={labelLocale} onSelect={(k) => reveal(currentDocId, k)} />
              </div>
            </details>
            <details className="rounded-lg border bg-background" data-list="issues" open={viewIssues.length > 0 ? undefined : false}>
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t("problemsList", { count: viewIssues.length })}</summary>
              <div className="border-t">
                <IssuesPanel issues={viewIssues} fields={viewDoc.fields} roles={viewRoles} typeLabels={typeLabels} form={viewDoc.form} labelLocale={labelLocale} onSelectField={(k) => reveal(currentDocId, k)} onSelectRole={() => {}} />
              </div>
            </details>
            <details className="rounded-lg border bg-background" data-list="roles">
              <summary className="cursor-pointer px-3 py-2 text-sm font-medium">{t("rolesList")}</summary>
              <div className="border-t">
                <RolesPanel
                  roles={viewRoles}
                  fields={viewDoc.fields}
                  form={viewDoc.form}
                  labelLocale={labelLocale}
                  readOnly={viewLocked}
                  rolesLocked={!viewDoc.fromTemplate}
                  flow
                  onAdd={(kind) => models.current[currentDocId]?.addRole(kind)}
                  onPatch={(k, patch) => models.current[currentDocId]?.patchRole(k, patch)}
                  onDelete={(k, to) => models.current[currentDocId]?.deleteRole(k, to)}
                />
              </div>
            </details>
          </div>
        ) : null}
      </div>
    </RoleEmailsProvider>
  );

  const goDoc = (i: number) => {
    jumpTo(i, null);
    if (layout === "tablet") setRightOpen(false);
  };
  const goPage = (i: number, p: number) => {
    jumpTo(i, p, undefined, i === position.doc);
    if (layout === "tablet") setRightOpen(false);
  };
  const navigator = (
    <DocNavigator covers={covers} fieldsOf={data.fieldsOf} sizes={sizes} opened={opened} current={position} onJumpDoc={goDoc} onJumpPage={goPage} personName={personName} />
  );

  const pagesInView = sizes[currentDocId]?.length || docs[position.doc]?.pageCount || 0;
  const blockedCount = docs.reduce((n, d) => {
    const x = ready(d.id);
    return x ? n + blockedBy(x, sizes[d.id]?.length || x.pageCount) : n;
  }, 0);
  const histNow = hist[targetDocId];

  const toolbarExtra = (
    <>
      {layout !== "desktop" ? <DocJumpSelect covers={covers} current={position} onJumpDoc={goDoc} /> : null}
      <p className="text-xs text-muted-foreground tabular-nums" data-position aria-live="off">
        {covers[position.doc]?.formOnly ? t("positionForm", { doc: position.doc + 1, total: docs.length }) : t("position", { doc: position.doc + 1, total: docs.length, page: position.page + 1, pages: pagesInView })}
      </p>
      {canSend ? <SaveStatus state={data.saveState} blockedBy={blockedCount} onRetry={() => void data.flush()} /> : null}
      {layout === "tablet" ? (
        <>
          <Button type="button" variant={leftOpen ? "default" : "outline"} size="sm" aria-pressed={leftOpen} onClick={() => { setLeftOpen((o) => !o); setRightOpen(false); }}>
            <PanelLeft />
            {t("toolsToggle")}
          </Button>
          <Button type="button" variant={rightOpen ? "default" : "outline"} size="sm" aria-pressed={rightOpen} onClick={() => { setRightOpen((o) => !o); setLeftOpen(false); }}>
            <PanelRight />
            {t("documentsToggle")}
          </Button>
        </>
      ) : null}
    </>
  );

  return (
    <div className="space-y-3">
    <CoverageSummary coverage={coverage} single={docs.length === 1} personName={personName} />
    <div ref={setRoot} className="flex h-[78vh] min-h-[520px] min-w-0 flex-col overflow-hidden rounded-lg border bg-background" onKeyDown={onKeyDown} data-blocks-editor data-layout={layout}>
      {phone ? (
        <div role="status" className="flex items-start gap-2 border-b bg-amber-500/10 px-3 py-2 text-sm">
          <Smartphone className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{te("phone.notice")}</span>
        </div>
      ) : null}
      <EditorToolbar
        canUndo={!!histNow?.canUndo}
        canRedo={!!histNow?.canRedo}
        onUndo={() => targetModel()?.undo()}
        onRedo={() => targetModel()?.redo()}
        zoom={zoom}
        fitPercent={fitPercent}
        onZoom={setZoom}
        preview={preview}
        onPreview={setPreview}
        readOnly={locked}
        compact={false}
        noPanel
        pageCount={0}
        currentPage={0}
        onGoto={() => {}}
        panelOpen={false}
        onPanel={() => {}}
        extra={toolbarExtra}
      />
      <div className="relative flex min-h-0 flex-1">
        {layout === "desktop" ? (
          <aside aria-label={t("toolsLabel")} className="w-72 shrink-0 overflow-y-auto border-r bg-card">
            {leftColumn}
          </aside>
        ) : null}
        <div
          ref={setScrollEl}
          tabIndex={-1}
          onScroll={() => schedule(false)}
          onWheel={stopSettling}
          onPointerDown={stopSettling}
          onTouchStart={stopSettling}
          onKeyDown={stopSettling}
          className="min-w-0 flex-1 overflow-auto bg-muted/50 p-4 outline-none"
          aria-label={te("canvas.label")}
        >
          <div ref={setContentEl} className="flex flex-col gap-8" data-scroll-content>
            {docs.map((d, i) => (
              <DocSection
                key={d.id}
                env={env}
                index={i}
                total={docs.length}
                docId={d.id}
                title={d.title}
                pageCount={d.pageCount}
                cover={covers[i]}
                load={data.loads[d.id] ?? LOADING}
                knownPages={sizes[d.id]}
                active={active.includes(i)}
                selectedKey={selected?.docId === d.id ? selected.key : null}
                unlocked={!!unlocked[d.id]}
                roleColors={perDoc[d.id]?.colors ?? NO_COLORS}
                roleEmails={perDoc[d.id]?.emails ?? NO_EMAILS}
              />
            ))}
          </div>
        </div>
        {layout === "desktop" ? (
          <aside aria-label={t("navigatorLabel")} className="w-56 shrink-0 border-l bg-card">
            {navigator}
          </aside>
        ) : null}
        {layout === "tablet" && leftOpen ? (
          <aside aria-label={t("toolsLabel")} className="absolute inset-y-0 left-0 z-40 w-72 max-w-full overflow-y-auto border-r bg-card shadow-xl">
            {leftColumn}
          </aside>
        ) : null}
        {layout === "tablet" && rightOpen ? <aside className="absolute inset-y-0 right-0 z-40 w-64 max-w-full border-l bg-card shadow-xl">{navigator}</aside> : null}
      </div>
    </div>
    </div>
  );
}

const NO_COLORS: Record<string, number> = {};
const NO_EMAILS: Record<string, string> = {};
