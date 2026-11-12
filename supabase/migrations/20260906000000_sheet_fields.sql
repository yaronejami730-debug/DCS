-- ---------------------------------------------------------------------
-- Programmable capture-sheet fields ("repères")
--
-- The capture sheet's fields — the three signature boxes, the mention, the
-- stamp, the name, the two dates — used to be the hardcoded TypeScript
-- constant `ATTESTATION_SHEET_V1` (packages/shared/src/captureSheet.ts).
-- This table replaces it with a per-owner, editable list: an owner can now
-- rename, add, remove and reorder fields from the console instead of
-- shipping a code change for each one.
--
-- `key` is what `templates.sheet_field` / `template_zones.sheet_field`
-- (migrations 20260115000000, 20260116000000) already reference — those
-- columns are untouched free text, so nothing there needs to change. Every
-- existing owner is seeded below with the eight fields of
-- `ATTESTATION_SHEET_V1`, keys and rects copied byte-for-byte, so an
-- account with signature routing already configured keeps working exactly
-- as printed — nothing shifts until the owner edits a field.
--
-- `rect_*` is always computed by `layoutSheetFields` (packages/shared) and
-- written by the API on every create/edit/delete/reorder — never typed in
-- by an owner directly, so the printed sheet and the detector's geometry
-- can never drift apart.
-- ---------------------------------------------------------------------

create table if not exists public.sheet_fields (
  owner_id     uuid not null references public.profiles (id) on delete cascade,
  key          text not null check (char_length(key) between 1 and 80),
  title        text not null check (char_length(title) between 1 and 160),
  label        text not null check (char_length(label) between 1 and 160),
  short_label  text not null check (char_length(short_label) between 1 and 60),
  hint         text not null check (char_length(hint) between 1 and 200),
  type         public.zone_type not null,
  size_class   text not null check (size_class in ('square', 'narrow', 'wide')),
  -- Lowercase, accent-free keywords a document's name is matched against.
  -- See sheetFieldTargetsDocument in captureSheet.ts.
  targets      jsonb not null default '[]'::jsonb,
  rect_x       double precision not null,
  rect_y       double precision not null,
  rect_w       double precision not null,
  rect_h       double precision not null,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (owner_id, key)
);

create index if not exists sheet_fields_owner_idx
  on public.sheet_fields (owner_id, sort_order);

drop trigger if exists sheet_fields_touch_updated_at on public.sheet_fields;
create trigger sheet_fields_touch_updated_at
  before update on public.sheet_fields
  for each row execute function public.touch_updated_at();

alter table public.sheet_fields enable row level security;

drop policy if exists sheet_fields_owner_all on public.sheet_fields;
create policy sheet_fields_owner_all on public.sheet_fields
  for all using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- Seed every existing owner with the current hardcoded layout, verbatim.
insert into public.sheet_fields
  (owner_id, key, title, label, short_label, hint, type, size_class, targets,
   rect_x, rect_y, rect_w, rect_h, sort_order)
select
  p.id,
  v.key, v.title, v.label, v.short_label, v.hint, v.type::public.zone_type, v.size_class,
  v.targets::jsonb,
  v.rect_x, v.rect_y, v.rect_w, v.rect_h, v.sort_order
from public.profiles p
cross join (values
  ('signature_1', 'ÉTUDE · DEVIS · ABSENCE DE TAMPON', 'Étude · Devis · Absence de tampon',
   'Signature', 'Signature du dirigeant', 'signature', 'square',
   '["etude","devis","absence de tampon"]',
   48::double precision, 150::double precision, 143.76::double precision, 143.76::double precision, 0),
  ('signature_2', 'AH · STOCKAGE', 'AH · Stockage',
   'Signature', 'Signature du dirigeant', 'signature', 'square',
   '["ah","honneur","stockage"]',
   225.76, 150, 143.76, 143.76, 1),
  ('signature_3', 'ATTESTATION DE FIN · ATTESTATION D''INSTALLATION', 'Attestation de fin · Attestation d''installation',
   'Signature', 'Signature du dirigeant', 'signature', 'square',
   '["fin","installation"]',
   403.52, 150, 143.76, 143.76, 2),
  ('mention', 'MENTION MANUSCRITE', 'Mention manuscrite',
   'Lu et approuvé', 'Écrivez à la main : « Lu et approuvé, bon pour accord »', 'mention', 'wide',
   '[]',
   48, 385.76, 279.168, 100, 3),
  ('stamp', 'TAMPON DE LA SOCIÉTÉ', 'Tampon de la société',
   'Tampon', 'Apposez le tampon de la société', 'stamp', 'wide',
   '[]',
   361.168, 385.76, 186.112, 100, 4),
  ('name', 'NOM ET PRÉNOM DU GÉRANT', 'Nom et prénom du gérant',
   'Nom du gérant', 'Écrivez à la main : nom, prénom, « le gérant »', 'free_text', 'narrow',
   '[]',
   48, 563.76, 181.1376, 74, 5),
  ('quote_date', 'DATE DU DEVIS', 'Date du devis',
   'Date du devis', 'Écrivez à la main la date du devis', 'quote_date', 'narrow',
   '[]',
   263.1376, 563.76, 125.0712, 74, 6),
  ('invoice_date', 'DATE DE FACTURE', 'Date de facture',
   'Date de facture', 'Écrivez à la main la date de facture', 'invoice_date', 'narrow',
   '["ah","honneur","stockage","fin","aft","travaux"]',
   422.2088, 563.76, 125.0712, 74, 7)
) as v(key, title, label, short_label, hint, type, size_class, targets, rect_x, rect_y, rect_w, rect_h, sort_order)
on conflict (owner_id, key) do nothing;

-- Extend the profile-creation trigger so a brand new owner also starts with
-- these eight fields instead of an empty sheet. Same values as the seed
-- above; kept as a second literal copy rather than a shared helper so this
-- trigger reads standalone and doesn't depend on the one-time backfill above
-- ever running again.
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

  insert into public.sheet_fields
    (owner_id, key, title, label, short_label, hint, type, size_class, targets,
     rect_x, rect_y, rect_w, rect_h, sort_order)
  values
    (new.id, 'signature_1', 'ÉTUDE · DEVIS · ABSENCE DE TAMPON', 'Étude · Devis · Absence de tampon',
     'Signature', 'Signature du dirigeant', 'signature', 'square',
     '["etude","devis","absence de tampon"]'::jsonb, 48, 150, 143.76, 143.76, 0),
    (new.id, 'signature_2', 'AH · STOCKAGE', 'AH · Stockage',
     'Signature', 'Signature du dirigeant', 'signature', 'square',
     '["ah","honneur","stockage"]'::jsonb, 225.76, 150, 143.76, 143.76, 1),
    (new.id, 'signature_3', 'ATTESTATION DE FIN · ATTESTATION D''INSTALLATION', 'Attestation de fin · Attestation d''installation',
     'Signature', 'Signature du dirigeant', 'signature', 'square',
     '["fin","installation"]'::jsonb, 403.52, 150, 143.76, 143.76, 2),
    (new.id, 'mention', 'MENTION MANUSCRITE', 'Mention manuscrite',
     'Lu et approuvé', 'Écrivez à la main : « Lu et approuvé, bon pour accord »', 'mention', 'wide',
     '[]'::jsonb, 48, 385.76, 279.168, 100, 3),
    (new.id, 'stamp', 'TAMPON DE LA SOCIÉTÉ', 'Tampon de la société',
     'Tampon', 'Apposez le tampon de la société', 'stamp', 'wide',
     '[]'::jsonb, 361.168, 385.76, 186.112, 100, 4),
    (new.id, 'name', 'NOM ET PRÉNOM DU GÉRANT', 'Nom et prénom du gérant',
     'Nom du gérant', 'Écrivez à la main : nom, prénom, « le gérant »', 'free_text', 'narrow',
     '[]'::jsonb, 48, 563.76, 181.1376, 74, 5),
    (new.id, 'quote_date', 'DATE DU DEVIS', 'Date du devis',
     'Date du devis', 'Écrivez à la main la date du devis', 'quote_date', 'narrow',
     '[]'::jsonb, 263.1376, 563.76, 125.0712, 74, 6),
    (new.id, 'invoice_date', 'DATE DE FACTURE', 'Date de facture',
     'Date de facture', 'Écrivez à la main la date de facture', 'invoice_date', 'narrow',
     '["ah","honneur","stockage","fin","aft","travaux"]'::jsonb, 422.2088, 563.76, 125.0712, 74, 7)
  on conflict (owner_id, key) do nothing;

  return new;
end;
$$;
