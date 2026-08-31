-- =====================================================================
-- A stamp applied over the signature is one mark, not two.
--
-- In practice the company stamp is very often pressed across the
-- signature rather than beside it. Framing them separately then meant
-- cutting one in half. `signature_stamp` is a single zone holding both,
-- extracted and placed as one image.
-- =====================================================================

alter type public.zone_type add value if not exists 'signature_stamp';

alter table public.signing_sessions
  add column if not exists signature_stamp_image_path text,
  add column if not exists signature_stamp_photo_path text;
