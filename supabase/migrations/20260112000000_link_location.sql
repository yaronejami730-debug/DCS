-- ---------------------------------------------------------------------
-- Proof of location for a signed return
-- ---------------------------------------------------------------------
--
-- A field signature is worth more with evidence of where it happened: the
-- technician signed on site, not from an office three towns away. The browser
-- will only give us that with the person's explicit consent — there is a
-- permission prompt and no way around it, by design — so this is a *consented*
-- proof of presence, not tracking. A link can ask for it; the technician grants
-- or refuses it; and what they grant is stored here, next to the pages it
-- vouches for.
--
--   folder_share_links.require_location
--     the operator turned the request on for this link. Off by default: asking
--     for someone's coordinates is a decision, not a default.
--
--   share_link_returns.latitude / longitude / accuracy / captured_at
--     what the technician's browser reported, when they allowed it. All null
--     when the link did not ask, or the technician declined — a refusal is a
--     valid outcome and must not block the signature.
-- ---------------------------------------------------------------------

alter table public.folder_share_links
  add column if not exists require_location boolean not null default false;

alter table public.share_link_returns
  add column if not exists latitude          double precision,
  add column if not exists longitude         double precision,
  -- Metres of uncertainty the browser reported, so the console can tell a
  -- GPS fix from a coarse network-derived guess.
  add column if not exists location_accuracy double precision,
  add column if not exists location_at       timestamptz;
