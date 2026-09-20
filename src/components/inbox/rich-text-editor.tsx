"use client";

import { useEffect, useRef } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Link from "@tiptap/extension-link";
import { TextStyle } from "@tiptap/extension-text-style";
import Color from "@tiptap/extension-color";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Italic,
  Underline as UnderlineIcon,
  Strikethrough,
  List,
  ListOrdered,
  Link as LinkIcon,
  Palette,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { pastedImages } from "@/lib/media/clipboard-images";
import { InlineImage } from "@/lib/tiptap/inline-image";

/** Small fixed palette rather than a full color picker — keeps the
 *  toolbar simple; covers the common "make this stand out" cases. */
const TEXT_COLORS = [
  { label: "Default", value: null },
  { label: "Blue", value: "#2563eb" },
  { label: "Green", value: "#16a34a" },
  { label: "Red", value: "#dc2626" },
  { label: "Gray", value: "#6b7280" },
];

interface RichTextEditorProps {
  /** Called on every content change with both the HTML and the
   *  plain-text derivation (Tiptap's own `getText()` — used as the
   *  send's plain-text fallback). */
  onChangeHtml: (html: string, text: string) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Exposes the live Tiptap instance so the composer can clear it
   *  after a successful send (`editor.commands.clearContent()`) —
   *  simpler than round-tripping content back down as a controlled
   *  prop, which fights Tiptap's own internal state. */
  onEditorReady?: (editor: Editor | null) => void;
  /** A picture pasted into the reply (a screenshot, "Copy image"). The parent
   *  stages it as an attachment chip; it is not put into the text. Leave out
   *  to let the editor paste as usual. */
  onImageFiles?: (files: File[]) => void;
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
      title={label}
      disabled={disabled}
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

export function RichTextEditor({
  onChangeHtml,
  placeholder,
  disabled,
  onEditorReady,
  onImageFiles,
}: RichTextEditorProps) {
  const onImageFilesRef = useRef(onImageFiles);
  useEffect(() => {
    onImageFilesRef.current = onImageFiles;
  }, [onImageFiles]);
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        codeBlock: false,
        blockquote: false,
        horizontalRule: false,
      }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true }),
      TextStyle,
      Color,
      // Pictures of a knowledge base article inserted into the reply keep their
      // place in the text; only this project's own uploaded files are accepted.
      InlineImage,
      Placeholder.configure({ placeholder: placeholder ?? "" }),
    ],
    editorProps: {
      attributes: { class: "rte-content" },
      handlePaste: (_view, event) => {
        const cb = onImageFilesRef.current;
        if (!cb) return false;
        const files = pastedImages(event.clipboardData?.files, event.clipboardData?.getData("text/plain"));
        if (files.length === 0) return false;
        event.preventDefault();
        cb(files);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      onChangeHtml(editor.getHTML(), editor.getText());
    },
    editable: !disabled,
    // Tiptap v3 renders on the client only — without this, Next.js's
    // server render and the client's first paint disagree and React
    // throws a hydration mismatch.
    immediatelyRender: false,
  });

  useEffect(() => {
    onEditorReady?.(editor ?? null);
    return () => onEditorReady?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const setLink = () => {
    if (!editor) return;
    const previousUrl = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("Link URL", previousUrl || "https://");
    if (url === null) return;
    if (url.trim() === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url.trim() }).run();
  };

  if (!editor) return null;

  return (
    <div className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border bg-muted/40 px-1.5 py-1">
        <ToolbarButton
          label="Bold"
          active={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          label="Italic"
          active={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          label="Underline"
          active={editor.isActive("underline")}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        >
          <UnderlineIcon className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          label="Strikethrough"
          active={editor.isActive("strike")}
          onClick={() => editor.chain().focus().toggleStrike().run()}
        >
          <Strikethrough className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="mx-1 h-4 w-px bg-border" />

        <ToolbarButton
          label="Bulleted list"
          active={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <List className="h-3.5 w-3.5" />
        </ToolbarButton>
        <ToolbarButton
          label="Numbered list"
          active={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          <ListOrdered className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="mx-1 h-4 w-px bg-border" />

        <ToolbarButton label="Insert link" active={editor.isActive("link")} onClick={setLink}>
          <LinkIcon className="h-3.5 w-3.5" />
        </ToolbarButton>

        <div className="mx-1 h-4 w-px bg-border" />

        <div className="flex items-center gap-0.5">
          <Palette className="h-3.5 w-3.5 text-muted-foreground" />
          {TEXT_COLORS.map((c) => (
            <button
              key={c.label}
              type="button"
              title={c.label}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() =>
                c.value
                  ? editor.chain().focus().setColor(c.value).run()
                  : editor.chain().focus().unsetColor().run()
              }
              className="h-4 w-4 rounded-full border border-border/60"
              style={{ backgroundColor: c.value ?? "transparent" }}
            />
          ))}
        </div>
      </div>

      <EditorContent editor={editor} className="max-h-56 min-h-[100px] overflow-y-auto px-3 py-2.5" />
    </div>
  );
}
