import { mergeAttributes, Node, type Editor } from "@tiptap/react";

// ============================================================
// An inline image for the knowledge editor and the email reply editor.
//
// Deliberately small: `src` and `alt` (the caption). It is an inline atom, so
// an image sits in a paragraph at the cursor and the HTML round-trips as
// `<p>text<img src alt>more</p>`, which is exactly what the server's
// sanitiser keeps.
//
// While a file uploads the node carries `uploadId` (written as data-upload-id)
// and a local preview `src`; the editor swaps in the public URL when the
// upload lands (see `updateImageByUploadId`).
//
// An `<img>` arriving by paste of HTML (a web page, PowerPoint) is only kept
// when its src is one of this project's own chat-media files: everything else
// (remote pictures, data: URLs, file: paths) is ignored, never inserted.
// ============================================================

/** Where this project's public chat-media files live. */
export function ownImagePrefix(): string | null {
  const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!base) return null;
  try {
    return `${new URL(base).origin}/storage/v1/object/public/chat-media/`;
  } catch {
    return null;
  }
}

/** True for a URL of one of this project's chat-media files. */
export function isOwnImageUrl(src: string | null | undefined): boolean {
  const prefix = ownImagePrefix();
  return !!src && !!prefix && src.startsWith(prefix);
}

export interface InlineImageOptions {
  /** Which `src` may be created from pasted or loaded HTML. */
  allowSrc: (src: string) => boolean;
}

export const InlineImage = Node.create<InlineImageOptions>({
  name: "image",
  inline: true,
  group: "inline",
  atom: true,
  draggable: true,
  selectable: true,

  addOptions() {
    return { allowSrc: isOwnImageUrl };
  },

  addAttributes() {
    return {
      src: { default: null },
      alt: {
        default: "",
        parseHTML: (el) => el.getAttribute("alt") ?? "",
      },
      uploadId: {
        default: null,
        parseHTML: (el) => el.getAttribute("data-upload-id"),
        renderHTML: (attrs) => (attrs.uploadId ? { "data-upload-id": attrs.uploadId } : {}),
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: "img[src]",
        getAttrs: (el) => {
          const src = (el as HTMLElement).getAttribute("src") ?? "";
          return this.options.allowSrc(src) ? null : false;
        },
      },
    ];
  },

  renderHTML({ HTMLAttributes }) {
    return ["img", mergeAttributes(HTMLAttributes)];
  },
});

/** Where an image with this `uploadId` sits, or null. */
function findByUploadId(editor: Editor, uploadId: string): { pos: number; size: number } | null {
  let found: { pos: number; size: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "image" && node.attrs.uploadId === uploadId) {
      found = { pos, size: node.nodeSize };
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Finish (or cancel) an upload: set the attributes of the placeholder, or
 * remove it when `attrs` is null. Not added to the undo history (undoing must
 * not bring back a half-finished placeholder). Returns false when the
 * placeholder is gone (the person deleted it while it uploaded).
 */
export function updateImageByUploadId(
  editor: Editor,
  uploadId: string,
  attrs: { src: string; alt?: string } | null,
): boolean {
  if (editor.isDestroyed) return false;
  const at = findByUploadId(editor, uploadId);
  if (!at) return false;
  const node = editor.state.doc.nodeAt(at.pos);
  if (!node) return false;
  const tr = editor.state.tr;
  if (attrs === null) tr.delete(at.pos, at.pos + at.size);
  else tr.setNodeMarkup(at.pos, undefined, { ...node.attrs, ...attrs, uploadId: null });
  tr.setMeta("addToHistory", false);
  editor.view.dispatch(tr);
  return true;
}

/** Remove every image whose `src` is `src` (the attachment was removed from
 *  the list). Returns how many were removed. */
export function removeImagesBySrc(editor: Editor, src: string): number {
  if (editor.isDestroyed) return 0;
  const hits: { pos: number; size: number }[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "image" && node.attrs.src === src) hits.push({ pos, size: node.nodeSize });
    return true;
  });
  if (hits.length === 0) return 0;
  const tr = editor.state.tr;
  // Back to front so earlier positions stay valid.
  for (const h of hits.reverse()) tr.delete(h.pos, h.pos + h.size);
  editor.view.dispatch(tr);
  return hits.length;
}

/** The `src` of every image in the editor, in document order. */
export function imageSrcsOf(editor: Editor): string[] {
  const out: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === "image" && typeof node.attrs.src === "string") out.push(node.attrs.src);
    return true;
  });
  return out;
}
