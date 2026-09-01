-- =====================================================================
-- Retire the templates the old "every document becomes a template"
-- behaviour left behind.
--
-- Before 20260103000000 every zone configuration created a library
-- entry, and that migration had to assume `reusable = true` for the
-- existing rows because nothing recorded the operator's intent. The
-- library therefore still lists one row per document ever configured,
-- which is exactly the pile the distinction was introduced to avoid.
--
-- A row is treated as one-off only when all three hold — anything the
-- operator plausibly meant to reuse is left alone:
--   * no source PDF: it was configured from a document in a folder, not
--     created on its own through "Nouveau template";
--   * no filename pattern: it was never given a rule to match future
--     imports, so it could only ever match its own bytes;
--   * at most one document uses it: no reuse has actually happened.
--
-- Nothing is deleted. The zones stay attached to the document that uses
-- them, and the console can list one-off templates (?all=true) and
-- promote one back by ticking "Réutilisable" in the editor.
-- =====================================================================

update public.templates t
set reusable = false
where t.reusable
  and t.source_pdf_path is null
  and t.filename_pattern is null
  and (select count(*) from public.documents d where d.template_id = t.id) <= 1;
