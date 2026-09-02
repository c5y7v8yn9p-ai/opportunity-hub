-- ============================================================
-- 009: OUTCOME EVENT TRACKING (view / save / apply)
-- First honest step toward "the product should learn from
-- outcomes" -- this just captures the data. No re-ranking model
-- is built on top of it yet.
-- ============================================================
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) on delete cascade,
  opportunity_id uuid references public.opportunities(id) on delete cascade,
  event_type text not null check (event_type in ('view','save','unsave','apply_click','contact_click')),
  created_at timestamptz not null default now()
);

alter table public.events enable row level security;

create policy "events insert own" on public.events
  for insert with check (auth.uid() = profile_id);

create policy "events select own" on public.events
  for select using (auth.uid() = profile_id);

create index if not exists events_profile_id_idx on public.events(profile_id);
create index if not exists events_opportunity_id_idx on public.events(opportunity_id);
