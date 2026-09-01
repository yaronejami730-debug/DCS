-- ---------------------------------------------------------------------
-- Four more mark types: date, quote_date, free_text, checkbox
-- ---------------------------------------------------------------------
--
-- The matching engine works by TYPE: a captured element declares what it is,
-- and lands only in a zone of the same type in the target document. "Date de
-- devis" therefore has to be a type of its own — distinct from "date" — in the
-- editor AND in capture, or the engine cannot tell which zone a quote date
-- belongs to.
--
-- All four behave like `mention` end to end: handwritten ink, cropped from the
-- signer's page, extracted, and stamped into the matching zone.

alter type public.zone_type add value if not exists 'date';
alter type public.zone_type add value if not exists 'quote_date';
alter type public.zone_type add value if not exists 'free_text';
alter type public.zone_type add value if not exists 'checkbox';
