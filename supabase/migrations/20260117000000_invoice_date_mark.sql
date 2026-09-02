-- ---------------------------------------------------------------------
-- One more handwritten mark: the invoice date
-- ---------------------------------------------------------------------
--
-- The attestation sheet gains a "Date de facture" box, filled once by the
-- signer and reproduced on the AH (attestation sur l'honneur) documents. Same
-- shape as the quote date: its own zone type, its own photo and cutout paths
-- on the signing session.
-- ---------------------------------------------------------------------

alter type public.zone_type add value if not exists 'invoice_date';

alter table public.signing_sessions
  add column if not exists invoice_date_image_path text,
  add column if not exists invoice_date_photo_path text;
