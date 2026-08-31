-- =====================================================================
-- A template carries its own PDF.
--
-- Templates could only be created from a document already sitting in a
-- folder, and the editor and the PDF export both had to hunt for a
-- document using the template just to have something to draw on. A
-- template now stores the PDF it was configured against, so it can be
-- created on its own — "Devis", "Contrat de vente" — and reused later
-- against whichever document matches.
-- =====================================================================

alter table public.templates
  add column if not exists source_pdf_path text,
  add column if not exists source_filename text;

comment on column public.templates.source_pdf_path is
  'The PDF this template was configured against. Lets the editor and the annotated export work without a document in a folder.';
