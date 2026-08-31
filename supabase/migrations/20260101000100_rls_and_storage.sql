-- =====================================================================
-- Row Level Security + private storage bucket
--
-- Rule: a signed-in user reads and writes ONLY their own rows.
-- Writes that must stay authoritative (statuses, final PDF paths, audit
-- entries) are left to the backend's service role, which bypasses RLS.
-- =====================================================================

alter table public.profiles          enable row level security;
alter table public.devices           enable row level security;
alter table public.templates         enable row level security;
alter table public.template_zones    enable row level security;
alter table public.folders           enable row level security;
alter table public.documents         enable row level security;
alter table public.signing_sessions  enable row level security;
alter table public.notifications     enable row level security;
alter table public.audit_logs        enable row level security;

-- profiles -----------------------------------------------------------
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select using (id = (select auth.uid()));

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- devices ------------------------------------------------------------
drop policy if exists devices_owner_all on public.devices;
create policy devices_owner_all on public.devices
  for all using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- templates ----------------------------------------------------------
drop policy if exists templates_owner_all on public.templates;
create policy templates_owner_all on public.templates
  for all using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists template_zones_owner_all on public.template_zones;
create policy template_zones_owner_all on public.template_zones
  for all using (
    exists (
      select 1 from public.templates t
      where t.id = template_zones.template_id and t.owner_id = (select auth.uid())
    )
  )
  with check (
    exists (
      select 1 from public.templates t
      where t.id = template_zones.template_id and t.owner_id = (select auth.uid())
    )
  );

-- folders / documents -------------------------------------------------
drop policy if exists folders_owner_all on public.folders;
create policy folders_owner_all on public.folders
  for all using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

drop policy if exists documents_owner_all on public.documents;
create policy documents_owner_all on public.documents
  for all using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- signing sessions ----------------------------------------------------
drop policy if exists signing_sessions_owner_all on public.signing_sessions;
create policy signing_sessions_owner_all on public.signing_sessions
  for all using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- notifications / audit: read-only for the account, written by the backend
drop policy if exists notifications_owner_select on public.notifications;
create policy notifications_owner_select on public.notifications
  for select using (owner_id = (select auth.uid()));

drop policy if exists audit_logs_owner_select on public.audit_logs;
create policy audit_logs_owner_select on public.audit_logs
  for select using (owner_id = (select auth.uid()));

-- ---------------------------------------------------------------------
-- Storage: one private bucket, four prefixes
--   originals/<owner>/…   immutable source PDFs
--   processed/<owner>/…   signed output
--   signatures/<owner>/…  transparent cutouts
--   stamps/<owner>/…      transparent cutouts
--   photos/<owner>/…      raw capture, deleted after successful processing
-- Clients never touch the bucket directly; the backend issues short-lived
-- signed URLs. No policy is granted to anon/authenticated on purpose.
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'scansign',
  'scansign',
  false,
  52428800, -- 50 MB
  array['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
