-- OpportunityHub V2.2 — Daily business/startup/employment news dashboard.
-- Run once in Supabase Dashboard -> SQL Editor -> New query, after
-- migrations/003_subscriptions.sql has already been run.
--
-- Separate from `opportunities` on purpose: these are informational
-- headlines, not things people apply to, so they don't belong mixed into
-- the job feed or the map.

create table if not exists public.news_items (
  id uuid primary key default gen_random_uuid(),
  category text not null check (category in ('business', 'startup', 'employment')),
  title text not null,
  summary text,
  url text not null unique,
  source text,
  published_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists news_items_category_idx on public.news_items(category);
create index if not exists news_items_published_idx on public.news_items(published_at desc);

alter table public.news_items enable row level security;

-- Readable by everyone, including logged-out visitors — no policy exists
-- for insert/update/delete from anon/authenticated, so only the scraper
-- (using the service_role key, which bypasses RLS) can ever write here.
create policy "news items are publicly readable"
  on public.news_items for select
  using (true);
