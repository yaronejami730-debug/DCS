-- ---------------------------------------------------------------------
-- Documents come back through the link
-- ---------------------------------------------------------------------
--
-- The flow this supports, end to end:
--
--   1. the operator puts the PDFs in a folder and shares a link
--   2. the technician opens it, downloads the documents, prints and signs them
--      by hand — four signatures, a "lu et approuvé", a date, whatever the
--      paperwork asks for
--   3. the technician photographs or scans the signed pages and sends them back
--      through the same link
--   4. the operator, on the console, crops each mark out of that scan and
--      places it on the zones the templates describe
--
-- Step 3 is what this table holds: the raw thing the technician returned,
-- before anyone has decided what is in it.
--
-- It is deliberately NOT a row in `documents`. A document is an original the
-- operator put in to be signed; a return is evidence coming back the other way.
-- Conflating them would put scans in the list of things still to sign, and make
-- "how many documents does this folder have" unanswerable.
-- ---------------------------------------------------------------------

create table if not exists public.share_link_returns (
  id            uuid primary key default gen_random_uuid(),
  link_id       uuid not null references public.folder_share_links (id) on delete cascade,
  folder_id     uuid not null references public.folders (id) on delete cascade,
  owner_id      uuid not null references public.profiles (id) on delete cascade,
  -- Which document this is a signed copy of, when the technician said so. Null
  -- when they just sent a photo of a page without picking one — which happens,
  -- and is better than refusing the upload.
  document_id   uuid references public.documents (id) on delete set null,
  filename      text not null,
  storage_path  text not null,
  content_type  text not null,
  byte_size     bigint not null check (byte_size > 0),
  -- Pixel size for an image; null for a PDF, whose pages are rasterised in the
  -- console at the moment of cropping.
  width         integer,
  height        integer,
  page_count    integer,
  -- Set once the operator has cropped marks out of it, so the console can show
  -- what is still waiting to be processed.
  handled_at    timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists share_link_returns_folder_idx
  on public.share_link_returns (folder_id, created_at desc);
create index if not exists share_link_returns_link_idx
  on public.share_link_returns (link_id);

-- Same as the other share tables: reached with the service role, and the
-- technician has no Supabase identity at all. No policy is the correct policy.
alter table public.share_link_returns enable row level security;

-- ---------------------------------------------------------------------
-- Where a session's photo came from
-- ---------------------------------------------------------------------
--
-- A signing session used to always start from a photo taken in the app. It can
-- now also start from a page of a returned scan, rasterised in the console. The
-- link back matters for the audit trail: "this signature came out of the scan
-- the technician sent on the 3rd" is the question someone will eventually ask.
alter table public.signing_sessions
  add column if not exists return_id uuid
  references public.share_link_returns (id) on delete set null;
