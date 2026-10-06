"use client";

// ============================================================
// The Doc Sign field editor: the pages of a PDF with fields laid over them. One controlled component used
// three ways: editing a template, preparing a draft made from a template (values), and preparing an uploaded
// draft (full placement). It does no network: the parent owns `fields` and `roles` and saves them.
// ============================================================

import { Smartphone } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { PdfPages, usePdf, useElementWidth } from "@/components/sign/pdf-pages";
import { groupFieldsByPage, fieldsOnPage, pageAtOffset, pageHeights, pageTops, pageWidthPx, percentOfWidth, type Zoom } from "@/lib/sign/client/editor-pages";
import type { EditorState } from "@/lib/sign/client/editor-history";
import type { SampleContext } from "@/lib/sign/client/editor-preview";
import { mergeKeysOf } from "@/lib/sign/client/layout";
import { FIELD_TYPES, type FieldType, type PlacedField } from "@/lib/sign/pdf/types";
import { MAX_FIELDS, validateFields, validateRoles } from "@/lib/sign/rules";
import type { SignRole } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

import { EditorToolbar } from "./editor-toolbar";
import { PageList } from "./page-list";
import { PageOverlay, type PageOverlayCallbacks } from "./page-overlay";
import { Palette } from "./palette";
import { SidePanel, type PanelTab } from "./side-panel";
import { useEditorModel, useStableCallback, type EditorSeeds } from "./use-editor-model";

export interface FieldEditorProps {
  pdfUrl: string;
  pdfVersion?: number | string;
  fields: PlacedField[];
  roles: SignRole[];
  /** Called with the new fields and roles after every change (and undo or redo). Hand them straight back as props. */
  onChange: (next: EditorState) => void;
  /** Values of the sender's merge fields, shown in the boxes and in preview. */
  mergeValues?: Record<string, unknown>;
  readOnly?: boolean;
  mode: "template" | "draft";
  className?: string;
  /** Extra controls at the right end of the toolbar. */
  toolbarExtra?: ReactNode;
}

const PAGE_GAP = 16;
const PAD = 16;

export function FieldEditor({ pdfUrl, pdfVersion, fields, roles, onChange, mergeValues, readOnly = false, mode, className, toolbarExtra }: FieldEditorProps) {
  const t = useTranslations("Sign.editor");
  const locale = useLocale();
  const pdf = usePdf(pdfUrl, pdfVersion);
  const [rootRef, rootWidth] = useElementWidth<HTMLDivElement>();
  const [scrollRef, scrollWidth] = useElementWidth<HTMLDivElement>();

  // the screen decides how much it can do: a phone only looks, a tablet gets the panel as a slide-over
  const phone = rootWidth > 0 && rootWidth < 640;
  const compact = rootWidth > 0 && rootWidth < 1024;
  const locked = readOnly || phone;

  const seeds = useMemo<EditorSeeds>(
    () => ({
      roleLabel: (kind, n) => t(kind === "signer" ? "seeds.signer" : "seeds.filler", { n }),
      dropdownOptions: [t("seeds.option", { n: 1 }), t("seeds.option", { n: 2 })],
      staticText: t("seeds.staticText"),
    }),
    [t],
  );
  const model = useEditorModel({ fields, roles, onChange, seeds });
  const { update, setRect, nudge, place, remove, duplicate, copyToEveryPage, copy, paste, addRole, patchRole, deleteRole, undo, redo } = model;

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [tool, setTool] = useState<FieldType | null>(null);
  const [activeRoleKey, setActiveRoleKey] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [preview, setPreview] = useState(false);
  const [tab, setTab] = useState<PanelTab>("field");
  const [panelOpen, setPanelOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [now] = useState(() => new Date());

  // ---- derived -------------------------------------------------------------------------------------
  const selected = useMemo(() => (selectedKey ? (fields.find((f) => f.key === selectedKey) ?? null) : null), [fields, selectedKey]);
  const activeRole = roles.find((r) => r.key === activeRoleKey)?.key ?? roles[0]?.key ?? null;
  const armedTool = locked ? null : tool;

  const [groups, setGroups] = useState(() => groupFieldsByPage(null, fields));
  const [groupsFor, setGroupsFor] = useState(fields);
  if (groupsFor !== fields) {
    setGroupsFor(fields);
    setGroups(groupFieldsByPage(groups, fields));
  }

  const ready = pdf.status === "ready" ? pdf : null;
  const pageCount = ready?.pages.length ?? 0;
  const issues = useMemo(() => [...validateRoles(roles), ...(ready ? validateFields(fields, roles, pageCount) : [])], [fields, roles, ready, pageCount]);
  const issueKeys = useMemo(() => new Set(issues.map((i) => i.field).filter((k): k is string => !!k)), [issues]);
  const mergeKeys = useMemo(() => mergeKeysOf(fields).map((m) => m.key), [fields]);

  const typeLabels = useMemo(() => Object.fromEntries(FIELD_TYPES.map((ty) => [ty, t(`types.${ty}`)])) as Record<FieldType, string>, [t]);
  const senderLabel = t("roles.sender");
  const sampleCtx = useMemo<SampleContext>(
    () => ({ mergeValues, now, locale, signerName: t("preview.signerName"), textPlaceholder: t("preview.text") }),
    [mergeValues, now, locale, t],
  );

  // ---- geometry of the column of pages -------------------------------------------------------------------
  const firstWidth = ready?.pages[0]?.width ?? 595;
  const pageWidth = pageWidthPx(zoom, firstWidth, scrollWidth - PAD * 2);
  const pxPerPt = pageWidth / firstWidth;
  const fitPercent = percentOfWidth(pageWidth, firstWidth);
  const heights = useMemo(() => (ready ? pageHeights(ready.pages, pageWidth) : []), [ready, pageWidth]);
  const tops = useMemo(() => pageTops(heights, PAGE_GAP, PAD), [heights]);

  const scrollFrame = useRef(0);
  const onScroll = () => {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      const el = scrollRef.current;
      if (!el) return;
      const page = pageAtOffset(tops, heights, el.scrollTop, el.clientHeight);
      setCurrentPage((p) => (p === page ? p : page));
    });
  };
  useEffect(
    () => () => {
      if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current);
    },
    [],
  );

  const goto = useCallback(
    (index: number, y = 0, smooth = true) => {
      const el = scrollRef.current;
      if (!el || index < 0 || index >= tops.length) return;
      const target = Math.max(0, tops[index] + y * heights[index] - (y > 0 ? el.clientHeight / 3 : PAD / 2));
      el.scrollTo({ top: target, behavior: smooth ? "smooth" : "auto" });
      setCurrentPage(index);
    },
    [scrollRef, tops, heights],
  );

  // ---- selection and placing -------------------------------------------------------------------------
  const focusField = (key: string) => {
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>(`[data-field="${key}"]`)?.focus({ preventScroll: true }));
  };

  const onSelect = useStableCallback((key: string | null) => {
    setSelectedKey(key);
    if (key) {
      const f = fields.find((x) => x.key === key);
      if (f && f.role !== "sender") setActiveRoleKey(f.role);
      setTab((cur) => (cur === "fields" || cur === "issues" ? cur : "field"));
    }
  });

  const onPlace = useStableCallback((type: FieldType, page: number, rect: { x: number; y: number; w: number; h: number }, keepTool: boolean) => {
    const key = place({ type, page, rect, preferredRole: activeRole });
    if (!key) return;
    setSelectedKey(key);
    setTab("field");
    if (!keepTool) setTool(null);
    focusField(key);
  });

  const revealField = useStableCallback((key: string) => {
    const f = fields.find((x) => x.key === key);
    setSelectedKey(key);
    if (f) {
      if (f.role !== "sender") setActiveRoleKey(f.role);
      goto(f.page, f.y);
      if (compact) setPanelOpen(true);
    }
    setTab((cur) => (cur === "fields" || cur === "issues" ? cur : "field"));
  });

  const overlayCallbacks = useMemo<PageOverlayCallbacks>(() => ({ select: onSelect, commitRect: (key, rect) => setRect(key, rect), place: onPlace }), [onSelect, setRect, onPlace]);

  const deleteSelected = () => {
    if (!selected) return;
    remove([selected.key]);
    setSelectedKey(null);
    scrollRef.current?.focus({ preventScroll: true });
  };
  const duplicateSelected = () => {
    if (!selected) return;
    const key = duplicate(selected.key);
    if (key) {
      setSelectedKey(key);
      focusField(key);
    }
  };
  const copySelectedToPages = () => {
    if (!selected) return;
    const r = copyToEveryPage(selected.key, pageCount);
    toast.success(r.added > 0 ? t("props.copiedToPages", { count: r.added }) : t("props.copiedNone"));
  };

  // ---- keyboard ---------------------------------------------------------------------------------------------
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const inForm = !!target.closest("input, textarea, select, [contenteditable='true']");
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (!locked && !inForm && mod && key === "z") {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (!locked && !inForm && mod && key === "y") {
      e.preventDefault();
      redo();
      return;
    }
    if (inForm || locked) return;
    if (e.key === "Escape") {
      if (tool) setTool(null);
      else setSelectedKey(null);
      return;
    }
    if (mod && key === "v") {
      e.preventDefault();
      const added = paste(currentPage);
      if (added) {
        setSelectedKey(added);
        focusField(added);
      }
      return;
    }
    if (!selected) return;
    if (mod && key === "c") {
      e.preventDefault();
      copy(selected.key);
    } else if (mod && key === "x") {
      e.preventDefault();
      copy(selected.key);
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
      const page = ready?.pages[selected.page];
      if (page) nudge(selected.key, dir, e.shiftKey, page, e.altKey);
    }
  };

  // ---- the pages ----------------------------------------------------------------------------------------------
  const pageNodes = ready ? (
    <PdfPages
      doc={ready.doc}
      pages={ready.pages}
      width={pageWidth}
      gap={PAGE_GAP}
      pageLabel={(i, n) => t("pages.go", { page: i + 1, count: n })}
      overlay={(index, size) => (
        <PageOverlay
          page={index}
          fields={fieldsOnPage(groups, index)}
          roles={roles}
          selectedKey={selected?.key ?? null}
          tool={armedTool}
          readOnly={locked}
          preview={preview}
          sampleCtx={sampleCtx}
          issueKeys={issueKeys}
          pageWidth={size.width}
          pageHeight={size.height}
          pxPerPt={pxPerPt}
          typeLabels={typeLabels}
          senderLabel={senderLabel}
          callbacks={overlayCallbacks}
        />
      )}
    />
  ) : null;

  const showPanel = !phone && (!compact || panelOpen);
  const panel = (
    <SidePanel
      tab={tab}
      onTab={setTab}
      fields={fields}
      roles={roles}
      selected={selected}
      readOnly={locked}
      typeLabels={typeLabels}
      senderLabel={senderLabel}
      mergeKeys={mergeKeys}
      pageCount={pageCount}
      issues={issues}
      issueKeys={issueKeys}
      onSelectFromList={revealField}
      onFieldChange={(change, coalesce) => selected && update(selected.key, change, coalesce)}
      onDuplicate={duplicateSelected}
      onCopyToPages={copySelectedToPages}
      onDelete={deleteSelected}
      onAddRole={(kind) => {
        const r = addRole(kind);
        if (r) setActiveRoleKey(r.key);
      }}
      onPatchRole={patchRole}
      onDeleteRole={deleteRole}
    />
  );

  return (
    <div ref={rootRef} className={cn("flex min-h-0 flex-col overflow-hidden rounded-lg border bg-background", className)} onKeyDown={onKeyDown} data-mode={mode}>
      {phone ? (
        <div role="status" className="flex items-start gap-2 border-b bg-amber-500/10 px-3 py-2 text-sm">
          <Smartphone className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{t("phone.notice")}</span>
        </div>
      ) : null}
      <EditorToolbar
        canUndo={model.canUndo}
        canRedo={model.canRedo}
        onUndo={undo}
        onRedo={redo}
        zoom={zoom}
        fitPercent={fitPercent}
        onZoom={setZoom}
        preview={preview}
        onPreview={setPreview}
        readOnly={locked}
        compact={compact}
        noPanel={phone}
        pageCount={pageCount}
        currentPage={currentPage}
        onGoto={(i) => goto(i)}
        panelOpen={panelOpen}
        onPanel={() => setPanelOpen((o) => !o)}
        extra={toolbarExtra}
      />
      {locked ? null : (
        <Palette tool={tool} onTool={setTool} roles={roles} activeRole={activeRole} onActiveRole={setActiveRoleKey} disabled={!ready} full={fields.length >= MAX_FIELDS} />
      )}
      <div className="relative flex min-h-0 flex-1">
        {!compact && ready ? (
          <aside className="w-[104px] shrink-0 border-r bg-card">
            <PageList pages={ready.pages} groups={groups} roles={roles} current={currentPage} onGoto={(i) => goto(i)} />
          </aside>
        ) : null}
        <div ref={scrollRef} tabIndex={-1} onScroll={onScroll} className="min-w-0 flex-1 overflow-auto bg-muted/50 p-4 outline-none" aria-label={t("canvas.label")}>
          {pdf.status === "loading" ? <p className="py-16 text-center text-sm text-muted-foreground">{t("canvas.loading")}</p> : null}
          {pdf.status === "error" ? (
            <p role="alert" className="py-16 text-center text-sm text-destructive">
              {t(pdf.code === "unreadable" ? "canvas.unreadable" : "canvas.fetchFailed")}
            </p>
          ) : null}
          {pageNodes}
        </div>
        {showPanel ? <aside className={cn("shrink-0 border-l bg-card", compact ? "absolute inset-y-0 right-0 z-40 w-80 max-w-full shadow-xl" : "w-80")}>{panel}</aside> : null}
      </div>
    </div>
  );
}
