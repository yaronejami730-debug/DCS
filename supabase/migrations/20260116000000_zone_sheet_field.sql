-- ---------------------------------------------------------------------
-- A zone can name the capture-sheet box it is filled from
-- ---------------------------------------------------------------------
--
-- The attestation's signature sheet has three signature boxes, one per group
-- of documents. Until now a template said which box signs it as a whole
-- (templates.sheet_field). The operator asked for the choice on the zone
-- itself — "Signature repère 2" drawn on the page — and for a second zone of
-- the same box to be a variant of that signature, not a copy.
--
-- Free text: the id of a field of the sheet layout in code
-- (packages/shared/src/captureSheet.ts). Null = the template-level choice, or
-- the keywords in the template's name, decide.
--
-- document_zones mirrors template_zones (a document's adjusted placement is a
-- copy of its template's zones), so it carries the column too.
-- ---------------------------------------------------------------------

alter table public.template_zones
  add column if not exists sheet_field text null;

alter table public.document_zones
  add column if not exists sheet_field text null;
