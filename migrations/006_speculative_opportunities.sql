-- OpportunityHub V2.3 — Phase 2: signal -> opportunity extraction.
-- Adds a 'speculative' status so the scraper can generate clearly-labeled
-- leads from high-value news signals (e.g. "Company X raised funding")
-- without ever mixing them into the real, confirmed-postings feed.
--
-- Every existing page already filters on status = 'active', so a
-- speculative row is automatically invisible everywhere until a page
-- explicitly asks for it — no other code had to change for this to be
-- safe. Run once in Supabase Dashboard -> SQL Editor -> New query, after
-- migrations 002-005 have already run.

alter table public.opportunities drop constraint if exists opportunities_status_check;
alter table public.opportunities add constraint opportunities_status_check
  check (status in ('draft','pending_review','active','paused','filled',
    'expired','removed','reported','speculative'));

create index if not exists opportunities_speculative_idx
  on public.opportunities(status) where status = 'speculative';
