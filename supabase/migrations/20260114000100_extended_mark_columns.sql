-- Separate file: Postgres refuses to USE a new enum value in the same
-- transaction that added it, and our runner wraps each file in one.
alter table public.signing_sessions
  add column if not exists date_image_path        text,
  add column if not exists date_photo_path        text,
  add column if not exists quote_date_image_path  text,
  add column if not exists quote_date_photo_path  text,
  add column if not exists free_text_image_path   text,
  add column if not exists free_text_photo_path   text,
  add column if not exists checkbox_image_path    text,
  add column if not exists checkbox_photo_path    text;
