"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, ExternalLink, History, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { useAuth } from "@/hooks/use-auth";
import { useCapability } from "@/hooks/use-can";
import { cn } from "@/lib/utils";
import { detectLanguage, KB_LANGUAGES, KB_LANGUAGE_LABELS, type KbLanguage } from "@/lib/ai/knowledge-query";
import { MAX_CONTENT_CHARS, MAX_TITLE_CHARS, type KbKind, type KbStatus } from "@/lib/ai/knowledge-doc";
import { canTranslateArticle } from "@/lib/knowledge/translate";
import type { ArticleDraftSeed, KnowledgeArticle, KnowledgeCollection } from "@/lib/knowledge-types";
import { deleteAccountMedia } from "@/lib/storage/upload-media";
import { removeImagesBySrc } from "@/lib/tiptap/inline-image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

import { KbAttachments } from "./kb-attachments";
import {
  buildSavePayload,
  inlineRowsMissingFromHtml,
  plainTextToEditorHtml,
  unsavedUploads,
  unwrapList,
  type AttachmentRow,
} from "./kb-editor-utils";
import { KbHistory } from "./kb-history";
import { KbRichEditor } from "./kb-rich-editor";
import { KbTestBox } from "./kb-test-box";
import { useKbInlineImages } from "./use-kb-inline-images";
import { KbInheritedFiles, KbLanguageChip, KbTranslationBanners, KbTranslationsCard } from "./kb-translations";

const selectClass =
  "h-9 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground outline-none focus:border-primary/50 disabled:opacity-60";

const NEW_COLLECTION = "__new__";

export interface KbEditorFormProps {
  /** null = a new article. */
  article: KnowledgeArticle | null;
  seed?: ArticleDraftSeed;
  /** "page" puts the actions in a header with a back link; "dialog" puts them
   *  in a footer and leaves the title to the surrounding dialog. */
  variant: "page" | "dialog";
  /** May this person change the article? false = a read-only view. */
  canEdit: boolean;
  onSaved: (result: { id: string; status: KbStatus }) => void;
  /** Dialog only: the Cancel button. */
  onCancel?: () => void;
  /** After a history restore; the parent reloads the article. */
  onRestored?: () => void;
  /** After translations were made, replaced or marked up to date; the parent
   *  reloads the article (default: refresh the page). */
  onTranslationsChanged?: () => void;
  /** Page only: where the back link goes. */
  backHref?: string;
}

function toRows(article: KnowledgeArticle | null): AttachmentRow[] {
  return (article?.attachments ?? []).map((a) => ({
    key: a.id,
    id: a.id,
    file_name: a.file_name,
    mime_type: a.mime_type,
    size_bytes: a.size_bytes,
    url: a.url,
    storage_path: a.storage_path,
    send_with_ai: a.send_with_ai,
    inline: a.inline,
    caption: a.caption,
    status: "ready" as const,
  }));
}

/**
 * The whole article editor: title (or question), rich body, attachments, the
 * settings column and the "would the AI find this?" box. Used by the
 * /knowledge pages and by the dialog opened from a chat or the unanswered
 * list. The parent remounts it (via `key`) to load another article, so its
 * initial state comes straight from `article` / `seed` with no reset effect.
 *
 * Admins choose Draft or Published; everyone else always saves a draft an
 * admin reviews (the server enforces that too).
 */
export function KbEditorForm({
  article,
  seed,
  variant,
  canEdit,
  onSaved,
  onCancel,
  onRestored,
  onTranslationsChanged,
  backHref = "/knowledge",
}: KbEditorFormProps) {
  const t = useTranslations("Knowledge.editor");
  const td = useTranslations("Knowledge.dialog");
  const tt = useTranslations("Knowledge.translations");
  const router = useRouter();
  // isAdmin here means "may publish": knowledge.publish (publish, edit anyone's
  // article, translate). Creating a collection is knowledge.manage.
  const isAdmin = useCapability("knowledge.publish");
  const canManageCollections = useCapability("knowledge.manage");
  const { user } = useAuth();

  const initialText = article?.content ?? seed?.content ?? "";
  const [kind, setKind] = useState<KbKind>(article?.kind ?? seed?.kind ?? "article");
  const [title, setTitle] = useState(article?.title ?? seed?.title ?? "");
  // The editor reads this once at mount; `html` below tracks later edits.
  const [initialHtml] = useState(() => article?.content_html || plainTextToEditorHtml(initialText));
  const [html, setHtml] = useState(initialHtml);
  const [text, setText] = useState(initialText);
  const [language, setLanguage] = useState<KbLanguage>(
    article?.language ?? seed?.language ?? detectLanguage(`${seed?.title ?? ""} ${seed?.content ?? ""}`) ?? "en",
  );
  const [collectionId, setCollectionId] = useState<string | null>(article?.collection_id ?? null);
  const [reviewBy, setReviewBy] = useState(article?.review_by ?? "");
  const [useInAi, setUseInAi] = useState(article?.use_in_ai ?? true);
  const [rows, setRows] = useState<AttachmentRow[]>(() => toRows(article));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState<"draft" | "published" | "agent" | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const [collections, setCollections] = useState<KnowledgeCollection[]>([]);
  const [newCollection, setNewCollection] = useState<string | null>(null);
  const [creatingCollection, setCreatingCollection] = useState(false);

  const isQa = kind === "qa";
  // A translation is an article of its own linked to a base article: its
  // language is fixed and it carries banners; a base article carries the
  // Translations card.
  const isTranslation = !!article?.translation_of;
  const translatedLanguages = new Set((article?.translations ?? []).map((x) => x.language));
  const status: KbStatus = article?.status ?? "draft";
  const readOnly = !canEdit;
  const busy = saving !== null;
  const uploading = rows.some((r) => r.status === "uploading");
  const overLimit = text.length > MAX_CONTENT_CHARS;
  const canSave = canEdit && !busy && !uploading && !overLimit && title.trim().length > 0 && text.trim().length > 0;

  // Files uploaded but never saved are removed if the editor goes away.
  const rowsRef = useRef(rows);
  const savedRef = useRef(false);
  // Pasted / dropped images go into the text through the live editor.
  const editorRef = useRef<Editor | null>(null);
  const addImages = useKbInlineImages({ editorRef, rowsRef, setRows, disabled: readOnly || busy });
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  useEffect(
    () => () => {
      if (savedRef.current) return;
      for (const u of unsavedUploads(rowsRef.current)) void deleteAccountMedia("chat-media", u.storage_path).catch(() => {});
    },
    [],
  );

  // Warn before a full-page navigation throws away edits.
  useEffect(() => {
    if (!dirty || variant !== "page") return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, variant]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/knowledge/collections", { cache: "no-store" });
        if (!res.ok) return;
        const list = unwrapList<KnowledgeCollection>(await res.json().catch(() => null), "collections");
        if (!cancelled) setCollections(list);
      } catch {
        // The select still works with "No collection"; not worth a toast.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const collectionOptions = useMemo(() => {
    // The article's own collection may not have loaded yet: keep it selectable.
    if (collectionId && !collections.some((c) => c.id === collectionId) && article?.category) {
      return [...collections, { id: collectionId, name: article.category, color: "", sort_order: 0 }];
    }
    return collections;
  }, [collections, collectionId, article?.category]);

  const touch = () => setDirty(true);
  const translationsChanged = () => (onTranslationsChanged ? onTranslationsChanged() : router.refresh());

  async function createCollection() {
    const name = (newCollection ?? "").trim();
    if (!name || creatingCollection) return;
    setCreatingCollection(true);
    try {
      const res = await fetch("/api/knowledge/collections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const data = await res.json().catch(() => ({}));
      const created = (data?.collection ?? data) as Partial<KnowledgeCollection> | undefined;
      if (!res.ok || !created?.id) {
        toast.error(typeof data?.error === "string" ? data.error : t("collectionFailed"));
        return;
      }
      setCollections((prev) => [...prev, created as KnowledgeCollection]);
      setCollectionId(created.id);
      setNewCollection(null);
      touch();
    } catch {
      toast.error(t("collectionFailed"));
    } finally {
      setCreatingCollection(false);
    }
  }

  async function save(target: KbStatus) {
    if (!canSave) return;
    setSaving(isAdmin ? target : "agent");
    try {
      const body = buildSavePayload({
        title,
        html,
        text,
        kind,
        language,
        useInAi,
        collectionId,
        reviewBy,
        status: isAdmin ? target : null,
        sourceConversationId: article ? null : seed?.sourceConversationId,
        attachments: rows,
      });
      const res = await fetch(article ? `/api/knowledge/${article.id}` : "/api/knowledge", {
        method: article ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? td("saveFailed"));
        return;
      }
      // Images deleted from the text were left out of the list, which removed
      // them on the server; an upload that was never saved has to go too.
      for (const u of unsavedUploads(inlineRowsMissingFromHtml(rows, html))) {
        void deleteAccountMedia("chat-media", u.storage_path).catch(() => {});
      }
      const saved: KbStatus = data.status ?? (isAdmin ? target : "draft");
      if (data.warning) toast.warning(data.warning);
      else toast.success(!isAdmin ? td("savedForReview") : saved === "published" ? td("savedPublished") : td("savedDraft"));

      const id = (data.id as string | undefined) ?? article?.id ?? "";
      // Close the loop on an unanswered question this article answers.
      if (seed?.resolvesGapId && id) {
        void fetch(`/api/knowledge/gaps/${seed.resolvesGapId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "resolved", resolved_document_id: id }),
        });
      }
      savedRef.current = true;
      setDirty(false);
      onSaved({ id, status: saved });
    } catch {
      toast.error(td("saveFailed"));
    } finally {
      setSaving(null);
    }
  }

  const spinner = (s: "draft" | "published") =>
    saving === (isAdmin ? s : "agent") ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null;

  const actions = readOnly ? null : isAdmin ? (
    status === "published" ? (
      <>
        <Button variant="outline" onClick={() => void save("draft")} disabled={!canSave}>
          {spinner("draft")}
          {t("moveToDrafts")}
        </Button>
        <Button onClick={() => void save("published")} disabled={!canSave}>
          {spinner("published")}
          {t("saveChanges")}
        </Button>
      </>
    ) : (
      <>
        <Button variant="outline" onClick={() => void save("draft")} disabled={!canSave}>
          {spinner("draft")}
          {t("saveDraft")}
        </Button>
        <Button onClick={() => void save("published")} disabled={!canSave}>
          {spinner("published")}
          {t("publish")}
        </Button>
      </>
    )
  ) : (
    <Button onClick={() => void save("draft")} disabled={!canSave}>
      {spinner("draft")}
      {t("saveDraft")}
    </Button>
  );

  function goBack(e: React.MouseEvent) {
    if (dirty && !window.confirm(t("discardConfirm"))) {
      e.preventDefault();
      return;
    }
  }

  return (
    <div className="space-y-4">
      {variant === "page" && (
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <Link
              href={backHref}
              onClick={goBack}
              className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" /> {t("back")}
            </Link>
            <span
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] font-medium",
                status === "published" ? "bg-green-500/15 text-green-700 dark:text-green-400" : "bg-muted text-muted-foreground",
              )}
            >
              {article ? (status === "published" ? t("statusPublished") : t("statusDraft")) : t("statusNew")}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-2">{actions}</div>
        </header>
      )}

      {readOnly && (
        <p className="rounded-lg border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
          {t("readOnlyNotice")}
        </p>
      )}

      {variant === "page" && article && isTranslation && (
        <KbTranslationBanners
          article={article}
          canRetranslate={
            canEdit && !!article.base && canTranslateArticle({ isAdmin, userId: user?.id ?? null, article: article.base })
          }
          canMarkCurrent={canEdit}
          dirty={dirty}
          onChanged={translationsChanged}
          onLeave={goBack}
        />
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="min-w-0 space-y-4">
          <div className="inline-flex rounded-lg border border-border bg-muted p-0.5 text-xs">
            {(["article", "qa"] as const).map((k) => (
              <button
                key={k}
                type="button"
                disabled={readOnly || busy}
                onClick={() => {
                  setKind(k);
                  touch();
                }}
                className={cn(
                  "rounded-md px-3 py-1 font-medium transition-colors disabled:cursor-not-allowed",
                  kind === k ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {td(k === "qa" ? "kindQa" : "kindArticle")}
              </button>
            ))}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <Label htmlFor="kb-title">{isQa ? td("question") : td("titleLabel")}</Label>
              {!isTranslation && <KbLanguageChip language={language} />}
            </div>
            <Input
              id="kb-title"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                touch();
              }}
              maxLength={MAX_TITLE_CHARS}
              placeholder={isQa ? td("questionPlaceholder") : td("titlePlaceholder")}
              disabled={readOnly || busy}
              className="h-10 text-base font-medium"
            />
          </div>

          <div className="space-y-1.5">
            <Label>{isQa ? td("answer") : td("content")}</Label>
            <KbRichEditor
              initialHtml={initialHtml}
              placeholder={isQa ? td("answerPlaceholder") : td("contentPlaceholder")}
              disabled={readOnly || busy}
              onImageFiles={readOnly ? undefined : (files, pos) => void addImages(files, pos)}
              onEditorReady={(editor) => {
                editorRef.current = editor;
              }}
              onChange={(h, tx) => {
                setHtml(h);
                setText(tx);
                touch();
              }}
            />
            {text.length > MAX_CONTENT_CHARS * 0.8 && (
              <p className={cn("text-right text-xs", overLimit ? "text-destructive" : "text-muted-foreground")}>
                {t("charCount", { count: text.length, max: MAX_CONTENT_CHARS })}
              </p>
            )}
          </div>

          {article && isTranslation && article.base && (
            <KbInheritedFiles
              files={article.inherited_attachments}
              baseLanguage={article.base.language}
              replaced={rows.length > 0}
            />
          )}

          <KbAttachments
            rows={rows}
            html={html}
            onRemoveRow={(row) => {
              // Removing an in-article image from the list takes it out of the text.
              if (row.inline && row.url && editorRef.current) removeImagesBySrc(editorRef.current, row.url);
            }}
            onChange={(update) => {
              setRows(update);
              touch();
            }}
            disabled={readOnly || busy}
          />
        </div>

        <aside className="space-y-4">
          <section className="space-y-3 rounded-xl border border-border bg-card p-3" aria-label={t("settings")}>
            <div className="space-y-1.5">
              <Label htmlFor="kb-collection">{t("collection")}</Label>
              <select
                id="kb-collection"
                className={selectClass}
                value={newCollection !== null ? NEW_COLLECTION : (collectionId ?? "")}
                disabled={readOnly || busy}
                onChange={(e) => {
                  if (e.target.value === NEW_COLLECTION) {
                    setNewCollection("");
                    return;
                  }
                  setNewCollection(null);
                  setCollectionId(e.target.value || null);
                  touch();
                }}
              >
                <option value="">{t("noCollection")}</option>
                {collectionOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
                {canManageCollections && <option value={NEW_COLLECTION}>{t("newCollection")}</option>}
              </select>
              {newCollection !== null && (
                <div className="flex gap-2">
                  <Input
                    autoFocus
                    value={newCollection}
                    onChange={(e) => setNewCollection(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        void createCollection();
                      }
                    }}
                    maxLength={60}
                    placeholder={t("newCollectionPlaceholder")}
                    aria-label={t("newCollectionPlaceholder")}
                    className="h-9"
                  />
                  <Button size="sm" onClick={() => void createCollection()} disabled={!newCollection.trim() || creatingCollection}>
                    {creatingCollection ? <Loader2 className="h-4 w-4 animate-spin" /> : t("createCollection")}
                  </Button>
                </div>
              )}
            </div>

            <label className="flex items-start justify-between gap-3">
              <span>
                <span className="block text-sm font-medium text-foreground">{td("useInAi")}</span>
                <span className="block text-xs text-muted-foreground">{t("useInAiOff")}</span>
              </span>
              <Switch
                checked={useInAi}
                onCheckedChange={(v) => {
                  setUseInAi(v);
                  touch();
                }}
                disabled={readOnly || busy}
              />
            </label>

            <div className="space-y-1.5">
              <Label htmlFor="kb-language">{td("language")}</Label>
              {isTranslation && article?.base ? (
                <div id="kb-language" className="space-y-1 rounded-md border border-border bg-muted px-2 py-1.5 text-sm text-foreground">
                  <p>{tt("languageFixed", { language: KB_LANGUAGE_LABELS[language], title: article.base.title })}</p>
                  <Link
                    href={`/knowledge/${article.base.id}`}
                    onClick={goBack}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    {tt("viewOriginal", { language: KB_LANGUAGE_LABELS[article.base.language] })}
                  </Link>
                </div>
              ) : (
                <select
                  id="kb-language"
                  className={selectClass}
                  value={language}
                  onChange={(e) => {
                    setLanguage(e.target.value as KbLanguage);
                    touch();
                  }}
                  disabled={readOnly || busy}
                >
                  {KB_LANGUAGES.map((l) => (
                    // A language one of its translations already uses would clash.
                    <option key={l} value={l} disabled={translatedLanguages.has(l)}>
                      {KB_LANGUAGE_LABELS[l]}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="kb-review">{td("reviewBy")}</Label>
              <Input
                id="kb-review"
                type="date"
                value={reviewBy}
                onChange={(e) => {
                  setReviewBy(e.target.value);
                  touch();
                }}
                disabled={readOnly || busy}
              />
            </div>

            {!isAdmin && !readOnly && <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{td("draftNotice")}</p>}

            {article?.source_url && (
              <a
                href={article.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 truncate text-xs text-primary hover:underline"
              >
                <ExternalLink className="h-3 w-3 shrink-0" />
                <span className="truncate">{t("importedFrom", { url: article.source_url })}</span>
              </a>
            )}

            {article && (
              <Button variant="ghost" size="sm" className="-ml-2" onClick={() => setHistoryOpen(true)}>
                <History className="mr-1.5 h-4 w-4" /> {t("history")}
              </Button>
            )}
          </section>

          {variant === "page" && !isTranslation && (
            <KbTranslationsCard
              article={article}
              canTranslate={canEdit && !!article}
              dirty={dirty}
              onChanged={translationsChanged}
              onLeave={goBack}
            />
          )}

          <KbTestBox articleId={article?.id ?? null} status={status} useInAi={useInAi} dirty={dirty} language={language} />
        </aside>
      </div>

      {variant === "dialog" && (
        <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            {td("cancel")}
          </Button>
          {actions}
        </div>
      )}

      {article && (
        <KbHistory
          articleId={article.id}
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          canRestore={canEdit}
          onRestored={() => {
            // The restored text replaces what is in the editor, so nothing
            // here is worth keeping: skip the leave-page warning and cleanup.
            setDirty(false);
            onRestored?.();
            if (!onRestored) router.refresh();
          }}
        />
      )}
    </div>
  );
}
