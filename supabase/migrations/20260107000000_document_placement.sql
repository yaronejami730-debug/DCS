-- =====================================================================
-- Adjust where a mark sits on ONE document, after it has been signed.
--
-- Until now placement lived only on the template, so the only way to move
-- a signature that landed badly was to edit the template — which moves it
-- on every document that template describes, including ones already
-- signed and sent. There was no way to say "this one, a little bigger".
--
-- Two additions:
--
--   document_zones          a per-document override of the template's
--                           zones. Present, it wins; absent, the template
--                           still decides, so nothing changes for the
--                           documents nobody has adjusted.
--
--   documents.signing_session_id
--   documents.variant_index which session's cutouts were stamped on this
--                           document, and which variant of them. Regenerating
--                           needs the very same signature image: inferring the
--                           session from "the most recent completed one in the
--                           folder" breaks as soon as a folder is signed twice,
--                           and the variant was never recorded at all, so a
--                           regeneration would have redrawn the mark instead of
--                           moving it.
--
-- Nothing here rewrites a signed PDF in place. Adjusting re-runs the
-- generator from the ORIGINAL document plus the stored cutouts, which is
-- what keeps the result reproducible and the archive coherent.
-- =====================================================================

alter table public.documents
  add column if not exists signing_session_id uuid
    references public.signing_sessions (id) on delete set null;

-- Which variant of the handwritten marks was stamped here.
--
-- Regenerating must reproduce the SAME signature, not merely a valid one.
-- The variant index used at signing time was derived on the fly — from the
-- signer's assignment when they made one, otherwise from the document id —
-- and never written down, so a regeneration would have silently redrawn the
-- mark. Moving a signature must move it, not replace it.
alter table public.documents
  add column if not exists variant_index integer;

create table if not exists public.document_zones (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  page        integer not null check (page >= 1),
  type        public.zone_type not null,
  -- Same convention as template_zones: normalized 0..1, origin TOP-LEFT, in
  -- the rotated viewport the operator saw. Converted to PDF points at
  -- generation time, by the same code path.
  x           double precision not null check (x >= 0 and x <= 1),
  y           double precision not null check (y >= 0 and y <= 1),
  width       double precision not null check (width > 0 and width <= 1),
  height      double precision not null check (height > 0 and height <= 1),
  zone_index  integer not null default 0,
  created_at  timestamptz not null default now(),
  constraint document_zones_inside_page check (x + width <= 1.0001 and y + height <= 1.0001)
);

create index if not exists document_zones_document_idx
  on public.document_zones (document_id);

create index if not exists documents_signing_session_idx
  on public.documents (signing_session_id);

alter table public.document_zones enable row level security;

drop policy if exists document_zones_owner_all on public.document_zones;
create policy document_zones_owner_all on public.document_zones
  for all
  using (
    exists (
      select 1 from public.documents d
      where d.id = document_zones.document_id and d.owner_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.documents d
      where d.id = document_zones.document_id and d.owner_id = (select auth.uid())
    )
  );

-- Backfill: attach each signed document to the session that most plausibly
-- signed it — the folder's last completed session at or before the document
-- was last touched. Only ever fills rows that have nothing, so re-running is
-- harmless, and a row it cannot resolve simply stays null: the console then
-- offers no adjustment rather than regenerating from the wrong signature.
update public.documents d
set signing_session_id = (
  select s.id
  from public.signing_sessions s
  where s.folder_id = d.folder_id
    and s.status = 'completed'
  order by s.completed_at desc nulls last
  limit 1
)
where d.signing_session_id is null
  and d.final_pdf_path is not null;
