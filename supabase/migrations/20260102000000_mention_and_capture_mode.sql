-- =====================================================================
-- A third kind of mark, and per-mark capture.
--
-- Some contracts require a handwritten "Lu et approuvé" next to the
-- signature. It is a distinct mark: its own zone in the template, its own
-- cutout, its own place on the page.
--
-- Capture can now be done two ways — everything on one sheet and framed
-- afterwards, or one photo per mark — so a session holds a photo per mark
-- rather than a single shared one.
-- =====================================================================

alter type public.zone_type add value if not exists 'mention';

-- One photo per mark. `photo_path` stays as the shared sheet used by the
-- single-photo flow, so existing sessions keep working unchanged.
alter table public.signing_sessions
  add column if not exists mention_image_path text,
  add column if not exists signature_photo_path text,
  add column if not exists stamp_photo_path text,
  add column if not exists mention_photo_path text,
  add column if not exists capture_mode text not null default 'single'
    check (capture_mode in ('single', 'per_mark'));

comment on column public.signing_sessions.capture_mode is
  'single = one sheet holding every mark, framed afterwards; per_mark = one photo per mark.';
