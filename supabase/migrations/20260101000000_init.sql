-- =====================================================================
-- Scan&Sign — initial schema
--
-- One account signs in on BOTH the web console and the iPhone app.
-- Every row is scoped to owner_id = the auth user that owns it, so a
-- document pushed from the web lands on that same account's devices.
--
-- The backend talks to Postgres with the service role and enforces
-- ownership in code; RLS below is the second line of defence that makes
-- the anon key useless for reading anyone else's data.
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------
-- profiles: public mirror of auth.users
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  display_name text,
  created_at  timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- shared enums
-- ---------------------------------------------------------------------
do $$ begin
  create type public.device_platform as enum ('ios', 'android', 'unknown');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.folder_status as enum
    ('pending', 'delivered', 'in_progress', 'processing', 'completed', 'error');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.document_status as enum
    ('awaiting_template', 'ready', 'processing', 'completed', 'error');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.session_status as enum
    ('awaiting_photo', 'awaiting_regions', 'processing', 'completed', 'error');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.zone_type as enum ('signature', 'stamp');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------
-- devices
-- ---------------------------------------------------------------------
create table if not exists public.devices (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references public.profiles (id) on delete cascade,
  name            text not null check (char_length(name) between 1 and 80),
  platform        public.device_platform not null default 'unknown',
  push_token      text,
  -- Stable per-install identifier so relaunching the app reuses this row
  -- instead of creating a duplicate device every cold start.
  installation_id text not null,
  last_seen_at    timestamptz,
  created_at      timestamptz not null default now(),
  unique (owner_id, installation_id)
);

create index if not exists devices_owner_idx on public.devices (owner_id);

-- ---------------------------------------------------------------------
-- templates + zones
-- ---------------------------------------------------------------------
create table if not exists public.templates (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references public.profiles (id) on delete cascade,
  name             text not null check (char_length(name) between 1 and 160),
  -- SHA-256 of the source PDF. Primary, most reliable matcher.
  document_hash    text check (document_hash is null or char_length(document_hash) = 64),
  -- Fallback matcher, combined with page_count. Never used alone when a hash exists.
  filename_pattern text,
  page_count       integer check (page_count is null or page_count > 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- A hash identifies exactly one template per account.
create unique index if not exists templates_owner_hash_idx
  on public.templates (owner_id, document_hash)
  where document_hash is not null;

create table if not exists public.template_zones (
  id          uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.templates (id) on delete cascade,
  page        integer not null check (page >= 1),
  type        public.zone_type not null,
  -- Normalized 0..1 rectangle, origin TOP-LEFT, expressed in the rotated
  -- viewport the operator saw. Converted to PDF points at generation time.
  x           double precision not null check (x >= 0 and x <= 1),
  y           double precision not null check (y >= 0 and y <= 1),
  width       double precision not null check (width > 0 and width <= 1),
  height      double precision not null check (height > 0 and height <= 1),
  zone_index  integer not null default 0,
  created_at  timestamptz not null default now(),
  constraint template_zones_inside_page check (x + width <= 1.0001 and y + height <= 1.0001)
);

create index if not exists template_zones_template_idx
  on public.template_zones (template_id, page);

-- ---------------------------------------------------------------------
-- folders + documents
-- ---------------------------------------------------------------------
create sequence if not exists public.folder_reference_seq start with 123;

create table if not exists public.folders (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.profiles (id) on delete cascade,
  -- Short human reference shown as "DOSSIER #000123".
  reference    bigint not null default nextval('public.folder_reference_seq'),
  name         text not null check (char_length(name) between 1 and 160),
  device_id    uuid references public.devices (id) on delete set null,
  status       public.folder_status not null default 'pending',
  error_code   text,
  error_message text,
  created_at   timestamptz not null default now(),
  delivered_at timestamptz,
  completed_at timestamptz
);

create index if not exists folders_owner_idx on public.folders (owner_id, created_at desc);
create index if not exists folders_device_idx on public.folders (device_id, status);

create table if not exists public.documents (
  id             uuid primary key default gen_random_uuid(),
  folder_id      uuid not null references public.folders (id) on delete cascade,
  owner_id       uuid not null references public.profiles (id) on delete cascade,
  filename       text not null,
  storage_path   text not null,
  final_pdf_path text,
  template_id    uuid references public.templates (id) on delete set null,
  document_hash  text not null,
  page_count     integer not null check (page_count > 0),
  byte_size      bigint not null check (byte_size > 0),
  status         public.document_status not null default 'awaiting_template',
  error_code     text,
  error_message  text,
  position       integer not null default 0,
  created_at     timestamptz not null default now()
);

create index if not exists documents_folder_idx on public.documents (folder_id, position);
create index if not exists documents_owner_status_idx on public.documents (owner_id, status);
create index if not exists documents_hash_idx on public.documents (document_hash);

-- ---------------------------------------------------------------------
-- signing sessions
-- ---------------------------------------------------------------------
create table if not exists public.signing_sessions (
  id                   uuid primary key default gen_random_uuid(),
  folder_id            uuid not null references public.folders (id) on delete cascade,
  owner_id             uuid not null references public.profiles (id) on delete cascade,
  device_id            uuid references public.devices (id) on delete set null,
  status               public.session_status not null default 'awaiting_photo',
  photo_path           text,
  photo_width          integer,
  photo_height         integer,
  signature_image_path text,
  stamp_image_path     text,
  error_code           text,
  error_message        text,
  created_at           timestamptz not null default now(),
  completed_at         timestamptz
);

create index if not exists signing_sessions_folder_idx
  on public.signing_sessions (folder_id, created_at desc);

-- ---------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------
create table if not exists public.notifications (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.profiles (id) on delete cascade,
  device_id  uuid references public.devices (id) on delete set null,
  folder_id  uuid references public.folders (id) on delete cascade,
  title      text not null,
  body       text not null,
  status     text not null default 'pending',
  ticket_id  text,
  error      text,
  created_at timestamptz not null default now()
);

create index if not exists notifications_owner_idx
  on public.notifications (owner_id, created_at desc);

-- ---------------------------------------------------------------------
-- audit log
-- ---------------------------------------------------------------------
create table if not exists public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles (id) on delete cascade,
  folder_id   uuid references public.folders (id) on delete set null,
  document_id uuid references public.documents (id) on delete set null,
  action      text not null,
  metadata    jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists audit_logs_owner_idx on public.audit_logs (owner_id, created_at desc);
create index if not exists audit_logs_folder_idx on public.audit_logs (folder_id, created_at desc);

-- ---------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists templates_touch_updated_at on public.templates;
create trigger templates_touch_updated_at
  before update on public.templates
  for each row execute function public.touch_updated_at();
