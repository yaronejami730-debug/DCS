-- =====================================================================
-- Reusable vs one-off templates.
--
-- Configuring zones for a single document used to add an entry to the
-- template library every time, so the list filled up with single-use
-- rows nobody would pick again. Reuse is now opt-in: only a template the
-- operator marked reusable shows in the library and takes part in
-- automatic matching on import.
--
-- Existing templates were all created before the distinction existed and
-- are treated as reusable, which is how they behaved.
-- =====================================================================

alter table public.templates
  add column if not exists reusable boolean not null default true;

comment on column public.templates.reusable is
  'False = configured for one document only; hidden from the library and skipped when matching an import.';

-- Automatic matching only ever considers reusable templates.
drop index if exists public.templates_owner_hash_idx;
create unique index if not exists templates_owner_hash_idx
  on public.templates (owner_id, document_hash)
  where document_hash is not null and reusable;

create index if not exists templates_owner_reusable_idx
  on public.templates (owner_id, reusable, updated_at desc);
