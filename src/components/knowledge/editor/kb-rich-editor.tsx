"use client";

import { useEffect, useRef } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import {
  Bold,
  Heading2,
  Heading3,
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
 */
export function KbRichEditor({ initialHtml, onChange, placeholder, disabled, className }: KbRichEditorProps) {
  const t = useTranslations("Knowledge.editor");
  // Latest callback without re-creating the editor when the parent re-renders.
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

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
          "[&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-left [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-muted-foreground [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]",
        ),
      },
    },
    onUpdate: ({ editor }) => {
      onChangeRef.current(editor.isEmpty ? "" : editor.getHTML(), editor.getText({ blockSeparator: "\n\n" }));
    },
    editable: !disabled,
    // Tiptap renders on the client only; without this the server render
    // and first client paint disagree and React reports a hydration error.
    immediatelyRender: false,
  });

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

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
      </div>

      <EditorContent editor={editor} className="max-h-[60vh] overflow-y-auto px-3 py-2.5" />
    </div>
  );
}
