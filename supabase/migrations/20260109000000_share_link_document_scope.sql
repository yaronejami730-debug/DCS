-- ---------------------------------------------------------------------
-- A share link covers a chosen subset of a folder's documents
-- ---------------------------------------------------------------------
--
-- A folder is a batch, not a single contract, and the people who sign it are
-- not interchangeable: the site technician signs the delivery notes, the
-- manager signs the contract, and neither should be handed the other's. Until
-- now every link reached every document in its folder, so splitting the work
-- meant splitting the folder — which defeats the point of a folder.
--
-- A link may now name the documents it covers. The rule is deliberately
-- permissive at the empty end:
--
--   no rows  -> the link covers the whole folder, including documents added
--               later. This is what an operator means by "sign this folder",
--               and it is what every existing link already did.
--   rows     -> the link covers exactly those documents and nothing else,
--               including nothing added afterwards.
--
-- Making "no rows" mean "nothing" instead would have turned every link created
-- before this migration into a dead one, and every link created by a UI that
-- forgets to send the list into a silent no-op.
-- ---------------------------------------------------------------------

create table if not exists public.folder_share_link_documents (
  link_id     uuid not null references public.folder_share_links (id) on delete cascade,
  document_id uuid not null references public.documents (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (link_id, document_id)
);

-- The signing path resolves a link to its documents on every submission.
create index if not exists share_link_documents_link_idx
  on public.folder_share_link_documents (link_id);

-- Same reasoning as folder_share_links: the API reaches this with the service
-- role, and a link holder has no Supabase identity at all. No policy is the
-- correct policy.
alter table public.folder_share_link_documents enable row level security;

-- ---------------------------------------------------------------------
-- Which link a signing session came from
-- ---------------------------------------------------------------------
--
-- The subset has to survive the round trip. The signer photographs a mark and
-- submits it minutes later, and by then the only thing tying that submission to
-- a link is this column — without it, processing would fall back to stamping
-- the whole folder and quietly undo the separation above.
--
-- Null means the console started the session, which covers the folder.
alter table public.signing_sessions
  add column if not exists share_link_id uuid
  references public.folder_share_links (id) on delete set null;
