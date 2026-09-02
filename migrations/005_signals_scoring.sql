-- OpportunityHub V2.2 — Signal classification/dedup fields + Opportunity
-- scoring + a link from an Opportunity back to the Signal it came from.
-- Additive only, safe to re-run. Run once in Supabase Dashboard -> SQL
-- Editor -> New query, after migrations 002/003/004 have already run.

-- ============================================================
-- 1. NEWS_ITEMS (Signals) — classification, importance, source trust,
--    and a source_count so near-duplicate headlines from multiple
--    outlets collapse into one row instead of cluttering the feed.
-- ============================================================
alter table public.news_items
  add column if not exists signal_type text default 'other'
    check (signal_type in ('funding','hiring','layoff','expansion','launch',
      'acquisition','regulation','government','market','business','technology','other')),
  add column if not exists importance_score integer not null default 0
    check (importance_score between 0 and 100),
  add column if not exists company text,
  add column if not exists location text,
  add column if not exists source_quality text not null default 'unverified'
    check (source_quality in ('verified','unverified')),
  add column if not exists source_count integer not null default 1;

create index if not exists news_items_signal_type_idx on public.news_items(signal_type);
create index if not exists news_items_importance_idx on public.news_items(importance_score desc);

-- ============================================================
-- 2. OPPORTUNITIES — a rule-based 0-100 score (freshness/completeness/
--    credibility — NOT an AI score, labelled "Opportunity Score" in the
--    UI), and an optional link back to the Signal that surfaced it.
-- ============================================================
alter table public.opportunities
  add column if not exists score integer not null default 0
    check (score between 0 and 100),
  add column if not exists signal_id uuid references public.news_items(id) on delete set null;

create index if not exists opportunities_score_idx on public.opportunities(score desc);
create index if not exists opportunities_signal_id_idx on public.opportunities(signal_id);
