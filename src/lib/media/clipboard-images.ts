// ============================================================
// Which files on a paste or a drop are images to stage.
//
// Pure (no DOM types beyond File), so the rules are testable. Two traps:
//  - Copying text or cells from PowerPoint / Excel / Word puts a rendered
//    picture (image/png) on the clipboard NEXT TO the text. Pasting that as an
//    image would be a surprise, so real text on the clipboard wins.
//  - "Copy image" in a browser, a screenshot tool and PowerPoint's "Copy as
//    picture" put the image on the clipboard with no meaningful text (at most
//    an <img> tag or a file name), which is what we want to catch.
// ============================================================

/** Image files among `files`, in order. */
export function imageFilesOf(files: ArrayLike<File> | null | undefined): File[] {
  if (!files) return []
  const out: File[] = []
  for (let i = 0; i < files.length; i++) {
    const f = files[i]
    if (f && typeof f.type === 'string' && f.type.toLowerCase().startsWith('image/')) out.push(f)
  }
  return out
}

/** The images to stage for a paste. `plainText` is the clipboard's text/plain:
 *  when it holds real text the paste is a text paste and nothing is staged. */
export function pastedImages(
  files: ArrayLike<File> | null | undefined,
  plainText: string | null | undefined,
): File[] {
  const images = imageFilesOf(files)
  if (images.length === 0) return []
  return (plainText ?? '').trim() ? [] : images
}

/** The images to stage for a drop: every dropped image file. A drag of text or
 *  a link carries no files, so it is left to the browser. */
export function droppedImages(files: ArrayLike<File> | null | undefined): File[] {
  return imageFilesOf(files)
}

/** True when a drag carries files (so the drop target may highlight). */
export function dragHasFiles(types: ArrayLike<string> | null | undefined): boolean {
  if (!types) return false
  for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true
  return false
}
