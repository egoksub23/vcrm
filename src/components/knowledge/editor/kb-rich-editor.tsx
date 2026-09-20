"use client";

import { useEffect, useRef } from "react";
import { useEditor, useEditorState, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Heading2,
  Heading3,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  Strikethrough,
  Underline as UnderlineIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { KB_CAPTION_MAX_CHARS } from "@/lib/knowledge-types";
import { droppedImages, pastedImages } from "@/lib/media/clipboard-images";
import { InlineImage } from "@/lib/tiptap/inline-image";
import { EmojiPicker } from "@/components/emoji/emoji-picker";
import { insertEmojiInEditor } from "@/lib/emoji/insert";
import { normalizeLinkUrl } from "./kb-editor-utils";

interface KbRichEditorProps {
  /** HTML the editor opens with. Read once at mount: the parent remounts
   *  the editor (via `key`) to load a different article, so there is no
   *  two-way sync to fight Tiptap's own state. */
  initialHtml: string;
  /** Called on every edit with the HTML ("" when empty) and its plain text. */
  onChange: (html: string, text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  /** Images pasted or dropped into the text (or chosen with the image button).
   *  `pos` is where a drop landed; a paste goes at the cursor. The parent
   *  uploads them and puts placeholders in the text. Leave out to turn image
   *  paste and the image button off. */
  onImageFiles?: (files: File[], pos?: number) => void;
  /** The live editor, so the parent can add, swap and remove images. */
  onEditorReady?: (editor: Editor | null) => void;
}

function ToolbarButton({
  onClick,
  active,
  disabled,
  label,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      // Keep the selection in the editor when the button is pressed.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40",
        active && "bg-primary/15 text-primary hover:bg-primary/15 hover:text-primary",
      )}
    >
      {children}
    </button>
  );
}

const Divider = () => <div className="mx-1 h-4 w-px bg-border" />;

/**
 * WYSIWYG body for a knowledge article: bold, italic, underline, strike,
 * H2/H3, lists, quote and links: the same set the server's sanitiser keeps,
 * so what is edited is what is stored. Tailwind preflight strips list
 * bullets and heading sizes, so those are restored on the content element.
 *
 * Images: pasting a picture (a screenshot, "Copy image", a PowerPoint shape
 * copied as a picture) or dropping image files hands them to `onImageFiles`;
 * an image in the text can be selected to give it a caption (its alt text).
 */
export function KbRichEditor({
  initialHtml,
  onChange,
  placeholder,
  disabled,
  className,
  onImageFiles,
  onEditorReady,
}: KbRichEditorProps) {
  const t = useTranslations("Knowledge.editor");
  // Latest callbacks without re-creating the editor when the parent re-renders.
  const onChangeRef = useRef(onChange);
  const onImageFilesRef = useRef(onImageFiles);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    onChangeRef.current = onChange;
    onImageFilesRef.current = onImageFiles;
  }, [onChange, onImageFiles]);

  const editor = useEditor({
    extensions: [
      // StarterKit v3 already bundles underline and link.
      StarterKit.configure({
        heading: { levels: [2, 3] },
        codeBlock: false,
        code: false,
        horizontalRule: false,
        link: { openOnClick: false, autolink: true },
      }),
      InlineImage,
      Placeholder.configure({ placeholder: placeholder ?? "" }),
    ],
    content: initialHtml,
    editorProps: {
      attributes: {
        class: cn(
          "min-h-[220px] text-[13.5px] leading-relaxed outline-none",
          "[&_p]:mb-2 [&_p:last-child]:mb-0",
          "[&_h2]:mb-2 [&_h2]:mt-3 [&_h2]:text-base [&_h2]:font-semibold",
          "[&_h3]:mb-1.5 [&_h3]:mt-2 [&_h3]:text-sm [&_h3]:font-semibold",
          "[&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5",
          "[&_blockquote]:mb-2 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground",
          "[&_a]:text-primary [&_a]:underline",
          "[&_img]:inline-block [&_img]:h-auto [&_img]:max-h-72 [&_img]:max-w-full [&_img]:rounded-md [&_img]:border [&_img]:border-border [&_img]:align-bottom",
          "[&_img.ProseMirror-selectednode]:outline-2 [&_img.ProseMirror-selectednode]:outline-primary",
          "[&_img[data-upload-id]]:animate-pulse [&_img[data-upload-id]]:opacity-60",
          "[&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-left [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-muted-foreground [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]",
        ),
      },
      handlePaste: (_view, event) => {
        const cb = onImageFilesRef.current;
        if (!cb) return false;
        const files = pastedImages(event.clipboardData?.files, event.clipboardData?.getData("text/plain"));
        if (files.length === 0) return false;
        event.preventDefault();
        cb(files);
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        const cb = onImageFilesRef.current;
        // `moved` = an image already in the text being dragged elsewhere.
        if (!cb || moved) return false;
        const files = droppedImages(event.dataTransfer?.files);
        if (files.length === 0) return false;
        event.preventDefault();
        cb(files, view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos);
        return true;
      },
    },
    onUpdate: ({ editor, transaction }) => {
      // Only real edits count: tiptap also emits "update" when the editor is
      // merely switched between editable and locked (on load and around each
      // save), which used to mark a freshly saved article as unsaved.
      if (!transaction.docChanged) return;
      onChangeRef.current(editor.isEmpty ? "" : editor.getHTML(), editor.getText({ blockSeparator: "\n\n" }));
    },
    editable: !disabled,
    // Tiptap renders on the client only; without this the server render
    // and first client paint disagree and React reports a hydration error.
    immediatelyRender: false,
  });

  useEffect(() => {
    // `false` = do not emit an "update" event for a mere editable toggle.
    editor?.setEditable(!disabled, false);
  }, [editor, disabled]);

  const onEditorReadyRef = useRef(onEditorReady);
  useEffect(() => {
    onEditorReadyRef.current = onEditorReady;
  }, [onEditorReady]);
  useEffect(() => {
    onEditorReadyRef.current?.(editor ?? null);
    return () => onEditorReadyRef.current?.(null);
  }, [editor]);

  // The image the cursor has selected (to caption it).
  const selectedImage = useEditorState({
    editor,
    selector: ({ editor: e }) =>
      e && e.isActive("image") ? { alt: String(e.getAttributes("image").alt ?? "") } : null,
    equalityFn: (a, b) => (a === null || b === null ? a === b : a.alt === b.alt),
  });

  const setLink = () => {
    if (!editor) return;
    const previous = editor.getAttributes("link").href as string | undefined;
    const input = window.prompt(t("linkPrompt"), previous || "https://");
    if (input === null) return;
    if (input.trim() === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    const href = normalizeLinkUrl(input);
    if (!href) {
      toast.error(t("linkInvalid"));
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
  };

  if (!editor) {
    return <div className={cn("min-h-[280px] rounded-xl border border-border bg-card", className)} />;
  }

  const off = !!disabled;
  return (
    <div className={cn("rounded-xl border border-border bg-card", className)}>
      <div
        role="toolbar"
        aria-label={t("toolbar")}
        className="flex flex-wrap items-center gap-0.5 border-b border-border bg-muted/40 px-1.5 py-1"
      >
        <ToolbarButton label={t("bold")} disabled={off} active={editor.isActive("bold")} onClick={() => editor.chain().focus().toggleBold().run()}>
          <Bold className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton label={t("italic")} disabled={off} active={editor.isActive("italic")} onClick={() => editor.chain().focus().toggleItalic().run()}>
          <Italic className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton label={t("underline")} disabled={off} active={editor.isActive("underline")} onClick={() => editor.chain().focus().toggleUnderline().run()}>
          <UnderlineIcon className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton label={t("strike")} disabled={off} active={editor.isActive("strike")} onClick={() => editor.chain().focus().toggleStrike().run()}>
          <Strikethrough className="h-3.5 w-3.5" />
        </ToolbarButton>

        <Divider />

        <ToolbarButton label={t("heading2")} disabled={off} active={editor.isActive("heading", { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
          <Heading2 className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton label={t("heading3")} disabled={off} active={editor.isActive("heading", { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
          <Heading3 className="h-3.5 w-3.5" />
        </ToolbarButton>

        <Divider />

        <ToolbarButton label={t("bulletList")} disabled={off} active={editor.isActive("bulletList")} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          <List className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton label={t("numberedList")} disabled={off} active={editor.isActive("orderedList")} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
          <ListOrdered className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton label={t("quote")} disabled={off} active={editor.isActive("blockquote")} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
          <Quote className="h-3.5 w-3.5" />
        </ToolbarButton>

        <Divider />

        <ToolbarButton label={t("link")} disabled={off} active={editor.isActive("link")} onClick={setLink}>
          <LinkIcon className="h-3.5 w-3.5" />
        </ToolbarButton>
        <EmojiPicker
          disabled={off}
          onPick={(emoji) => insertEmojiInEditor(editor, emoji)}
          returnFocusTo={() => editor.view.dom as HTMLElement}
          className="h-7 w-7"
        />
        {onImageFiles && (
          <>
            <ToolbarButton label={t("insertImage")} disabled={off} onClick={() => fileInputRef.current?.click()}>
              <ImageIcon className="h-3.5 w-3.5" />
            </ToolbarButton>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              data-testid="kb-image-input"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                if (files.length > 0) onImageFiles(files);
                // Let the same picture be chosen again.
                e.target.value = "";
              }}
            />
          </>
        )}
      </div>

      {selectedImage && (
        <div className="flex items-center gap-2 border-b border-border bg-primary/5 px-3 py-1.5">
          <label htmlFor="kb-image-caption" className="shrink-0 text-xs font-medium text-foreground">
            {t("imageCaption")}
          </label>
          <input
            id="kb-image-caption"
            value={selectedImage.alt}
            maxLength={KB_CAPTION_MAX_CHARS}
            disabled={off}
            placeholder={t("imageCaptionPlaceholder")}
            onChange={(e) => editor.chain().updateAttributes("image", { alt: e.target.value }).run()}
            onKeyDown={(e) => {
              // Enter finishes the caption and puts the cursor back in the text.
              if (e.key === "Enter") {
                e.preventDefault();
                editor.chain().focus().run();
              }
            }}
            className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary/50 disabled:opacity-60"
          />
        </div>
      )}

      <EditorContent editor={editor} className="max-h-[60vh] overflow-y-auto px-3 py-2.5" />
    </div>
  );
}
