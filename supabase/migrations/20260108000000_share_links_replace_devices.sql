-- ---------------------------------------------------------------------
-- Share links replace registered devices
-- ---------------------------------------------------------------------
--
-- A folder used to be *sent to a device*: the signer installed an app, the app
-- registered itself, and the operator picked it from a list. That bought a push
-- notification and cost everything else — an install, an account, an App Store,
-- and a signer who owns the right kind of phone.
--
-- A folder is now *shared as a link*. The token in the URL is the whole
-- authorisation: it names one folder, it can be revoked, and it expires. The
-- signer opens it in whatever browser they already have.
--
-- DESTRUCTIVE. This drops `devices` and every reference to it, including stored
-- Expo push tokens. Nothing reads those any more, but they are not coming back
-- once this runs. Take a backup first if the project holds real device rows.
-- ---------------------------------------------------------------------

-- --- the links -------------------------------------------------------------

create table if not exists public.folder_share_links (
  id             uuid primary key default gen_random_uuid(),
  folder_id      uuid not null references public.folders (id) on delete cascade,
  owner_id       uuid not null references public.profiles (id) on delete cascade,
  -- The secret itself. Stored in the clear on purpose: the console has to be
  -- able to show the operator the link again, and re-display is impossible
  -- against a hash. It is the same class of secret as the signed storage URLs
  -- this system already hands out, and it is scoped to one folder.
  token          text not null unique check (char_length(token) between 24 and 128),
  -- What the operator called it: "Marie Dupont", "client Renault".
  label          text check (char_length(label) between 1 and 120),
  -- How much of the folder the holder may see.
  --
  --   signer   — an outside technician. Capture only: they may photograph a
  --              mark and upload a PDF, and they see nothing of the folder.
  --   operator — the account holder on their own phone, reached by scanning a
  --              QR code off their own console. Same capture flow, but they may
  --              also read the documents and their zones, because they are the
  --              person who is allowed to.
  --
  -- Defaulting to the narrower one is deliberate: a link created by a path that
  -- forgets to set this must be the harmless kind.
  scope          text not null default 'signer' check (scope in ('signer', 'operator')),
  expires_at     timestamptz,
  revoked_at     timestamptz,
  last_opened_at timestamptz,
  opened_count   integer not null default 0,
  created_at     timestamptz not null default now()
);

-- The signer's every request arrives with nothing but the token, so this index
-- is on the hot path of the entire public flow.
create index if not exists share_links_token_idx on public.folder_share_links (token);
create index if not exists share_links_folder_idx on public.folder_share_links (folder_id, created_at desc);

-- Locked down completely: the API reaches this table with the service role, and
-- the signer has no Supabase identity at all — only a token our own middleware
-- resolves. No policy is therefore the correct policy.
alter table public.folder_share_links enable row level security;

-- Counting opens without a read-modify-write race. Two people opening the same
-- link at once is ordinary, and the count is shown to the operator as evidence
-- the signer received it — worth being correct.
create or replace function public.increment_share_link_open(link_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.folder_share_links
     set opened_count   = opened_count + 1,
         last_opened_at = now()
   where id = link_id;
$$;

revoke all on function public.increment_share_link_open(uuid) from public, anon, authenticated;

-- --- drop the device world -------------------------------------------------

-- The index goes with the column; Postgres drops it either way, but naming it
-- keeps this migration readable next to the init script that created it.
drop index if exists public.folders_device_idx;

alter table public.folders            drop column if exists device_id;
alter table public.signing_sessions   drop column if exists device_id;
alter table public.notifications      drop column if exists device_id;

-- The policy is dropped explicitly rather than left to the cascade, so that
-- re-running this against a partially migrated database cannot fail on it.
drop policy if exists devices_owner_all on public.devices;
drop table if exists public.devices;
drop type if exists public.device_platform;
