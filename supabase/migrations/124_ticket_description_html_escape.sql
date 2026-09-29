-- Ticket descriptions move from plain text to rich-text HTML (RichTextEditor,
-- table support). Existing descriptions are still plain text; rendering them
-- through dangerouslySetInnerHTML as-is would break on a literal '&'/'<'/'>'
-- and collapse every line break. Escape them once into safe HTML that reads
-- identically to how they rendered before (whitespace-pre-wrap).
--
-- Idempotent: skips any row that already contains '<' — either already
-- escaped by a prior run of this migration, or already real HTML written by
-- the new editor — so re-running it is a no-op for those rows.
UPDATE public.tickets
SET description = replace(
  replace(
    replace(
      replace(
        replace(description, '&', '&amp;'),
        '<', '&lt;'
      ),
      '>', '&gt;'
    ),
    E'\r\n', '<br>'
  ),
  E'\n', '<br>'
)
WHERE description IS NOT NULL
  AND description NOT LIKE '%<%';
