-- ---------------------------------------------------------------------
-- A template can name the capture-sheet box that signs it
-- ---------------------------------------------------------------------
--
-- The "attestation simplifiée" ends with a printed sheet of boxes framed by
-- markers: one signature box per group of documents (devis/étude/tampon,
-- AH/stockage, fin/installation), plus the mention, the name and the date.
-- When the signed sheet comes back, the console needs to know which box goes
-- onto which template.
--
-- By default it guesses from keywords in the template's name. This column is
-- the explicit answer when the name says nothing: the id of a field of the
-- sheet layout (see packages/shared/src/captureSheet.ts), e.g. 'signature_2'.
-- Free text rather than an enum because the layout lives in code and will grow.
-- ---------------------------------------------------------------------

alter table public.templates
  add column if not exists sheet_field text null;
