-- Fix: opportunities.company was never migrated, even though the scraper,
-- company.html, graph.html, and every company link on the site have
-- assumed it exists since the "company fix" and Opportunity Graph/Company
-- Intelligence work earlier tonight. news_items.company was added back in
-- migration 005 -- this is the same column, just missing on the sibling
-- table.
--
-- Effect of the bug: every scraper insert since the company-fix commit
-- has been a single batched POST with a "company" key on a nonexistent
-- column, so PostgREST rejected the whole batch and 0 opportunities were
-- inserted (confirmed live: nothing newer than 2026-09-02T11:32 UTC as of
-- the 2026-09-03 03:00 UTC scheduled run). This migration fixes it going
-- forward; no backfill of company on existing rows is possible since the
-- data was never captured for them.
--
-- Paste into Supabase Dashboard -> SQL Editor and run.

alter table public.opportunities add column if not exists company text;

create index if not exists opportunities_company_idx on public.opportunities(company) where company is not null;
