-- ---------------------------------------------------------------------
-- A PDF in a folder plays one of two roles
-- ---------------------------------------------------------------------
--
-- Both are PDFs, both live in the same folder, and until now the system treated
-- them identically — which was wrong, because they travel in opposite
-- directions and only one of them ever gets stamped.
--
--   to_sign      the contracts. They carry the zones, they receive the marks,
--                and the folder is "terminé" when every one of them has a
--                signed PDF. This is what a document has always been.
--
--   for_signing  the sheet the technician prints, signs by hand and photographs
--                back. It is the *source* of the ink, not a target for it: it
--                has no zones, it is never stamped, and it must never hold the
--                folder open waiting for a template it will never have.
--
-- Defaulting to 'to_sign' keeps every existing row meaning exactly what it
-- meant before this migration, and makes the harmless value the one a code path
-- that forgets to set it will land on.
-- ---------------------------------------------------------------------

alter table public.documents
  add column if not exists role text not null default 'to_sign'
  check (role in ('to_sign', 'for_signing'));

-- The two are almost always queried apart — "what still needs a template" and
-- "what does this link send" are different questions about the same folder.
create index if not exists documents_folder_role_idx
  on public.documents (folder_id, role);
