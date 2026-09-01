-- ---------------------------------------------------------------------
-- Live presence on a share link
-- ---------------------------------------------------------------------
--
-- The operator sends a link and then waits, blind. These two columns are the
-- difference between "did they even open it?" and watching the job happen: the
-- signer's page reports what it is doing — opened, viewing a document,
-- printing, sending — and the console shows a green dot with the step.
--
-- Deliberately two flat columns, not an events table. The question the
-- operator asks is "what is happening NOW", and the last write answers it;
-- a history would be an audit surface nobody asked for, holding a timeline
-- of somebody's minute-by-minute behaviour that we are better off not
-- keeping.
create table if not exists public._noop_presence_marker ();
drop table if exists public._noop_presence_marker;

alter table public.folder_share_links
  add column if not exists last_activity_at   timestamptz,
  add column if not exists last_activity_step text
    check (last_activity_step in ('opened', 'viewing', 'printing', 'sending', 'sent'));
