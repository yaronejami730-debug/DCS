-- A signed scan can now be imported by the operator directly, with no share
-- link behind it. The return then has no link_id; it is otherwise the same
-- row and goes through « Capturer les signatures » unchanged.
alter table public.share_link_returns alter column link_id drop not null;
