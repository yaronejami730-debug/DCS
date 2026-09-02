-- Qhare's own file number ("numdossier", e.g. 2023-123456) and the street
-- address: both are things an operator types into the search box.
alter table public.crm_leads
  add column if not exists reference text,
  add column if not exists address text;
