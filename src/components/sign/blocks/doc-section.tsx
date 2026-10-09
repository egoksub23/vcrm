"use client";

// ============================================================
// Secure Sign, step 3: ONE document's part of the continuous scroll. A slim header that sticks to the top while its pages are on the screen
// ("2 of 3 · Resignation Letter · 1 page" and how many blocks it has), a collapsible area for what belongs to the document itself (its form, the
// values to fill in, replacing the file), then its pages with the blocks over them. A form with nothing printed has no pages: a card stands in
// its place in the sequence.
//
// The document's blocks are the parent's state (so the left column and the navigator read them at once); what lives here is the editing model of
// THIS document (its undo history, its clipboard), the open file (only while the document is near the screen), and the page layers.
// ============================================================

import { AlertCircle, ChevronDown, FileUp, LayoutTemplate, Lock, LockOpen } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { memo, useEffect, useLayoutEffect, useMemo, useState } from "react";

import { DraftValuesPanel } from "@/components/sign/editor/draft-values-panel";
import { PageOverlay, type PageOverlayCallbacks } from "@/components/sign/editor/page-overlay";
import { ReplaceFileDialog } from "@/components/sign/editor/replace-file-dialog";
import { RoleEmailsProvider, type RoleEmails } from "@/components/sign/editor/role-emails";
import { SaveAsTemplateDialog } from "@/components/sign/editor/save-as-template-dialog";
import { useEditorModel, useStableCallback, type EditorModel, type EditorSeeds } from "@/components/sign/editor/use-editor-model";
import { PdfPages, usePdf, type PdfPageSize } from "@/components/sign/pdf-pages";
import { FormPartsSummary } from "@/components/sign/send/form-fields-step";
import { Button } from "@/components/ui/button";
import { documentFileUrl } from "@/lib/sign/client/api";
import type { EditorState } from "@/lib/sign/client/editor-history";
import type { SampleContext } from "@/lib/sign/client/editor-preview";
import { fieldsOnPage, groupFieldsByPage, pageHeights } from "@/lib/sign/client/editor-pages";
import { errorMessageKey, mergeKeysOf, type Rect } from "@/lib/sign/client/layout";
import { pageSizesOf } from "@/lib/sign/client/blocks-nav";
import type { DocCover } from "@/lib/sign/client/process";
import { FIELD_TYPES, type FieldType } from "@/lib/sign/pdf/types";
import type { SignLocale, SignRole } from "@/lib/sign/types";
import { cn } from "@/lib/utils";

import { docIssues, docLocked, type BlocksDoc, type BlocksLoad } from "./use-blocks-data";

export const PAGE_GAP = 16;

/** What a document's part of the scroll tells the editor around it, and asks of it. Every function is stable. */
export interface SectionCtl {
  /** The model of a document's editing (for undo, delete, nudge, place), or null when it goes away. */
  register: (docId: string, model: EditorModel | null) => void;
  history: (docId: string, canUndo: boolean, canRedo: boolean) => void;
  /** The file was opened (with the real size of its pages, kept after it is closed) or closed (null). */
  opened: (docId: string, open: { doc: PDFDocumentProxy; pages: PdfPageSize[] } | null) => void;
  layout: (docId: string, next: EditorState) => void;
  value: (docId: string, key: string, value: string) => void;
  select: (docId: string, key: string | null) => void;
  place: (docId: string, type: FieldType, page: number, rect: Rect, keepTool: boolean) => void;
  toggleUnlock: (docId: string) => void;
  reload: (docId: string, fileReplaced?: boolean) => void;
  flush: (docId: string) => Promise<boolean>;
  /** Something was saved or replaced: the process reads itself again. */
  changed: () => void;
}

/** What every document's part shares: how wide the pages are, which tool is armed, who may do what. */
export interface SectionEnv {
  pageWidth: number;
  scrollRoot: HTMLElement | null;
  tool: FieldType | null;
  preview: boolean;
  phone: boolean;
  canSend: boolean;
  canTemplates: boolean;
  ctl: SectionCtl;
}

export interface DocSectionProps {
  env: SectionEnv;
  index: number;
  total: number;
  docId: string;
  title: string;
  /** The pages as the process says, until the file is open. */
  pageCount: number | null;
  /** The document's coverage, from the blocks on screen. */
  cover: DocCover;
  load: BlocksLoad;
  /** The real page sizes, when the file has been opened before. */
  knownPages: PdfPageSize[] | undefined;
  /** The file is near the screen (or being jumped to): open it. */
  active: boolean;
  selectedKey: string | null;
  unlocked: boolean;
  roleColors: Readonly<Record<string, number>>;
  roleEmails: RoleEmails;
}

const NO_EMAILS: RoleEmails = {};

function DocSectionImpl(props: DocSectionProps) {
  const { env, index, total, docId, title, cover, load } = props;
  const t = useTranslations("Sign.process.multi");
  const tb = useTranslations("Sign.process.blocks");
  const te = useTranslations("Sign.editor");
  const data = load.status === "ready" ? load.data : null;
  const pages = props.knownPages?.length || data?.pageCount || props.pageCount || 0;
  // the part opens by itself when the document has a form or values still to write; after that it is the reader's to open and close
  const [shown, setShown] = useState<boolean | null>(null);
  const [initialOpen, setInitialOpen] = useState<boolean | null>(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const [replaceOpen, setReplaceOpen] = useState(false);
  // decided once, when the document has been read (not again as the values are typed, which would close the area under the reader's cursor)
  if (data && initialOpen === null) setInitialOpen(!!data.form || mergeKeysOf(data.fields).some((k) => !data.values[k.key]?.trim()));
  const open = shown ?? initialOpen ?? false;
  const locked = data ? docLocked(data, env, props.unlocked) : true;
  const editable = !!data && data.isDraft && env.canSend;
  const blocks = cover.blocks;

  return (
    <section data-doc-index={index} data-doc-id={docId} aria-label={t("docRegion", { n: index + 1, total, title })} className="relative min-w-0">
      <div className="sticky top-0 z-20 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-card px-3 py-2 shadow-sm" data-doc-header>
        <p className="min-w-0 flex-1 truncate text-sm text-foreground">
          <span className="text-muted-foreground tabular-nums">{t("docOf", { n: index + 1, total })}</span>
          <span className="mx-1.5 text-muted-foreground" aria-hidden>
            ·
          </span>
          <span className="font-semibold">{title}</span>
          {cover.formOnly ? null : (
            <>
              <span className="mx-1.5 text-muted-foreground" aria-hidden>
                ·
              </span>
              <span className="text-muted-foreground">{tb("pages", { count: pages })}</span>
            </>
          )}
        </p>
        <span
          data-doc-chip
          data-blocks={blocks}
          className={cn("shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium", blocks > 0 ? "border-border bg-muted text-foreground" : "border-[light-dark(#f59e0b,#b45309)] bg-amber-500/10 text-[light-dark(#92400e,#fcd34d)]")}
        >
          {cover.formOnly ? tb("formBadge") : blocks > 0 ? tb("blockCount", { count: blocks }) : t("noBlocksYet")}
        </span>
        {data ? (
          <Button type="button" variant="ghost" size="xs" aria-expanded={open} aria-controls={`doc-options-${docId}`} onClick={() => setShown(!open)}>
            {t("options")}
            <ChevronDown className={cn("transition-transform", open && "rotate-180")} aria-hidden />
          </Button>
        ) : null}
      </div>

      {data && open ? (
        <div id={`doc-options-${docId}`} className="mt-3 space-y-3" data-doc-options>
          {!data.isDraft ? (
            <p role="status" className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              {te("draft.notDraft")}
            </p>
          ) : !env.canSend ? (
            <p role="status" className="rounded-lg border bg-muted/40 px-3 py-2 text-sm">
              {te("draft.noPermission")}
            </p>
          ) : data.fromTemplate && !props.unlocked && !data.formOnly ? (
            <p className="text-sm text-muted-foreground">{te("draft.fromTemplate")}</p>
          ) : null}
          {data.form ? <FormPartsSummary form={data.form} roles={data.roles} id={`form-summary-${docId}`} /> : null}
          <DraftValuesPanel fields={data.fields} values={data.values} readOnly={!editable} onChange={(k, v) => env.ctl.value(docId, k, v)} />
          {editable && !env.phone ? (
            <div className="flex flex-wrap items-center gap-2">
              {data.fromTemplate && !data.formOnly ? (
                <Button type="button" variant="outline" size="sm" aria-pressed={props.unlocked} onClick={() => env.ctl.toggleUnlock(docId)}>
                  {props.unlocked ? <LockOpen /> : <Lock />}
                  {props.unlocked ? te("draft.lockFields") : te("draft.editFields")}
                </Button>
              ) : null}
              {data.hasFile && !data.formOnly ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setReplaceOpen(true)}>
                  <FileUp />
                  {te("draft.replaceFile")}
                </Button>
              ) : null}
              {env.canTemplates ? (
                <Button type="button" variant="outline" size="sm" onClick={() => setTemplateOpen(true)}>
                  <LayoutTemplate />
                  {te("draft.saveAsTemplate")}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="mt-3">
        {load.status === "loading" ? <p className="py-10 text-center text-sm text-muted-foreground">{te("draft.loading")}</p> : null}
        {load.status === "error" ? (
          <div role="alert" className="space-y-3 py-10 text-center">
            <p className="text-sm text-destructive">{te(errorMessageKey(load.code))}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => env.ctl.reload(docId)}>
              {te("save.retry")}
            </Button>
          </div>
        ) : null}
        {data && data.formOnly ? (
          <div data-card className="rounded-xl border border-dashed border-border bg-card/60 px-4 py-5 text-sm text-muted-foreground" data-doc-card={docId}>
            {data.form ? t("formCard") : tb("formEmpty")}
          </div>
        ) : null}
        {data && !data.formOnly && !data.hasFile ? <p role="alert" className="py-10 text-center text-sm text-muted-foreground">{te("draft.noFile")}</p> : null}
        {data && !data.formOnly && data.hasFile ? <DocPages {...props} data={data} locked={locked} /> : null}
      </div>

      {data && editable && data.hasFile && !data.formOnly ? (
        <ReplaceFileDialog documentId={docId} fields={data.fields} open={replaceOpen} onOpenChange={setReplaceOpen} beforeStart={() => env.ctl.flush(docId)} onReplaced={() => { env.ctl.reload(docId, true); env.ctl.changed(); }} />
      ) : null}
      {data && editable && env.canTemplates ? <SaveAsTemplateDialog documentId={docId} defaultName={title} open={templateOpen} onOpenChange={setTemplateOpen} beforeSubmit={() => env.ctl.flush(docId)} /> : null}
    </section>
  );
}

export const DocSection = memo(DocSectionImpl);

// ---- the pages of a document that has them --------------------------------------------------------------------------

type PagesProps = DocSectionProps & { data: BlocksDoc; locked: boolean };

function DocPages({ env, docId, data, locked, active, knownPages, pageCount, selectedKey, roleColors, roleEmails }: PagesProps) {
  const t = useTranslations("Sign.editor");
  const tf = useTranslations("Sign.formBuilder");
  const locale = useLocale();
  const labelLocale = (["en", "ms", "zh", "ko"].includes(locale) ? locale : "en") as SignLocale;
  const { ctl, pageWidth } = env;
  const [attempt, setAttempt] = useState(0);
  const pdf = usePdf(active ? documentFileUrl(docId) : null, `${data.fileVersion}.${attempt}`);
  const ready = pdf.status === "ready" ? pdf : null;

  // the saved roles go to the model untouched; what is drawn may use another colour (one person, one colour on every document)
  const rolesSaved = data.roles;
  const roles = useMemo<SignRole[]>(() => rolesSaved.map((r) => (roleColors[r.key] === undefined || roleColors[r.key] === r.color ? r : { ...r, color: roleColors[r.key] })), [rolesSaved, roleColors]);
  const seeds = useMemo<EditorSeeds>(
    () => ({ roleLabel: (kind, n) => t(kind === "signer" ? "seeds.signer" : "seeds.filler", { n }), dropdownOptions: [t("seeds.option", { n: 1 }), t("seeds.option", { n: 2 })], staticText: t("seeds.staticText") }),
    [t],
  );
  const model = useEditorModel({ fields: data.fields, roles: rolesSaved, onChange: (next) => ctl.layout(docId, next), seeds, rolesLocked: !data.fromTemplate });
  useLayoutEffect(() => {
    ctl.register(docId, model);
  });
  useEffect(() => () => ctl.register(docId, null), [ctl, docId]);
  useEffect(() => {
    ctl.history(docId, model.canUndo, model.canRedo);
  }, [ctl, docId, model.canUndo, model.canRedo]);
  useEffect(() => {
    ctl.opened(docId, ready ? { doc: ready.doc, pages: ready.pages } : null);
  }, [ctl, docId, ready]);
  useEffect(() => () => ctl.opened(docId, null), [ctl, docId]);

  const fields = data.fields;
  const [groups, setGroups] = useState(() => groupFieldsByPage(null, fields));
  const [groupsFor, setGroupsFor] = useState(fields);
  if (groupsFor !== fields) {
    setGroupsFor(fields);
    setGroups(groupFieldsByPage(groups, fields));
  }

  const sizes = useMemo(() => ready?.pages ?? pageSizesOf(knownPages, data.pageCount || pageCount), [ready, knownPages, data.pageCount, pageCount]);
  const firstWidth = sizes[0]?.width ?? 595;
  const pxPerPt = pageWidth / firstWidth;
  const issues = useMemo(() => docIssues(data, sizes.length), [data, sizes.length]);
  const issueKeys = useMemo(() => new Set(issues.map((i) => i.field).filter((k): k is string => !!k)), [issues]);
  const typeLabels = useMemo(() => Object.fromEntries(FIELD_TYPES.map((ty) => [ty, t(`types.${ty}`)])) as Record<FieldType, string>, [t]);
  const senderLabel = t("roles.sender");
  const [now] = useState(() => new Date());
  const form = data.form;
  const sampleCtx = useMemo<SampleContext>(
    () => ({ mergeValues: data.values, now, locale, signerName: t("preview.signerName"), textPlaceholder: t("preview.text"), form, sampleItem: (n: number) => tf("editor.sampleItem", { n }) }),
    [data.values, now, locale, t, tf, form],
  );
  const select = useStableCallback((key: string | null) => ctl.select(docId, key));
  const place = useStableCallback((type: FieldType, page: number, rect: Rect, keep: boolean) => ctl.place(docId, type, page, rect, keep));
  const { setRect } = model;
  const stableCallbacks = useMemo<PageOverlayCallbacks>(() => ({ select, commitRect: (key, rect) => setRect(key, rect), place }), [select, setRect, place]);

  const heights = pageHeights(sizes, pageWidth);
  const layer = (index: number, readOnly: boolean, height: number) => (
    <PageOverlay
      page={index}
      fields={fieldsOnPage(groups, index)}
      roles={roles}
      selectedKey={selectedKey}
      tool={readOnly ? null : env.tool}
      readOnly={readOnly}
      preview={env.preview}
      sampleCtx={sampleCtx}
      issueKeys={issueKeys}
      pageWidth={pageWidth}
      pageHeight={height}
      pxPerPt={pxPerPt}
      typeLabels={typeLabels}
      senderLabel={senderLabel}
      form={form}
      labelLocale={labelLocale}
      callbacks={stableCallbacks}
    />
  );

  return (
    <RoleEmailsProvider value={roleEmails ?? NO_EMAILS}>
      <div data-doc-pages={docId} className="relative">
        {pdf.status === "error" ? (
          <div role="alert" className="mb-3 flex flex-wrap items-center justify-center gap-3 text-sm text-destructive">
            <AlertCircle className="size-4" aria-hidden />
            {t(pdf.code === "unreadable" ? "canvas.unreadable" : "canvas.fetchFailed")}
            <Button type="button" variant="outline" size="xs" onClick={() => setAttempt((a) => a + 1)}>
              {t("save.retry")}
            </Button>
          </div>
        ) : null}
        {ready ? (
          <PdfPages
            doc={ready.doc}
            pages={ready.pages}
            width={pageWidth}
            gap={PAGE_GAP}
            release
            scrollRoot={env.scrollRoot}
            pageLabel={(i, n) => t("pages.go", { page: i + 1, count: n })}
            overlay={(index, size) => layer(index, locked, size.height)}
          />
        ) : (
          // not open (far from the screen, or still being read): the pages as empty sheets of the right height, with the blocks over them, so the scroll keeps its length
          <div className="flex flex-col items-center" style={{ gap: PAGE_GAP }}>
            {sizes.map((_, index) => (
              <div key={index} role="group" aria-label={t("pages.go", { page: index + 1, count: sizes.length })} data-page={index} className="relative mx-auto overflow-hidden bg-white shadow-sm ring-1 ring-black/10" style={{ width: pageWidth, height: heights[index] }}>
                {index === 0 && active && pdf.status === "loading" ? <span className="absolute inset-x-0 top-6 text-center text-xs text-black/50">{t("canvas.loading")}</span> : null}
                {layer(index, true, heights[index])}
              </div>
            ))}
          </div>
        )}
      </div>
    </RoleEmailsProvider>
  );
}
