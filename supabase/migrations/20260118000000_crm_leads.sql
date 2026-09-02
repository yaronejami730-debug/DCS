-- ---------------------------------------------------------------------
-- A local mirror of the CRM's leads, fed by its webhooks
-- ---------------------------------------------------------------------
--
-- Qhare's API only writes (create/update lead, create/update appointment);
-- it has no endpoint to list or search leads. What it does have is webhooks:
-- on every lead created or modified, it POSTs the lead to a URL. So the
-- console's client search runs against this table, kept current by those
-- calls, and never asks Qhare a question it cannot answer.
--
-- The payload is stored whole (`payload`) next to the fields we map, so a
-- field Qhare sends that we did not anticipate is not lost — the mapping can
-- be tightened later without asking Qhare to resend anything.
-- ---------------------------------------------------------------------

create table if not exists public.crm_leads (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.profiles (id) on delete cascade,
  provider     text not null default 'qhare',
  external_id  text not null,
  name         text not null,
  first_name   text,
  last_name    text,
  company      text,
  phone        text,
  email        text,
  city         text,
  postal_code  text,
  category     text,
  state        text,
  payload      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (owner_id, provider, external_id)
);

create index if not exists crm_leads_owner_name_idx on public.crm_leads (owner_id, name);
alter table public.crm_leads enable row level security;
drop policy if exists crm_leads_owner_all on public.crm_leads;
create policy crm_leads_owner_all on public.crm_leads
  for all using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

-- The secret in the webhook URL: whoever knows it may push leads into this
-- account and nothing else. Rotatable by clearing it.
alter table public.profiles
  add column if not exists crm_webhook_token text unique;

-- Which CRM lead a folder belongs to, when it was created from one.
alter table public.folders
  add column if not exists crm_lead_id text;
