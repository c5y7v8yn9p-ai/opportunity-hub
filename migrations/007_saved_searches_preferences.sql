-- Phase 3 — RETENTION
-- Saved searches (with an in-app "N new matches" indicator instead of email
-- alerts — no email service is wired up, so this stays a no-new-infra
-- feature: nothing to configure, nothing that can silently fail to send),
-- plus a lightweight preferences blob on profiles that personalizes the
-- default feed (default filters, default "show speculative leads").
-- Paste this into Supabase Dashboard → SQL Editor and run it.

-- ============================================================
-- 1. SAVED SEARCHES
-- ============================================================
create table if not exists public.saved_searches (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  name text not null,
  query jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Bumped every time the user opens this saved search from their profile.
  -- "New matches" badges compare opportunities.created_at against this.
  last_viewed_at timestamptz not null default now()
);

alter table public.saved_searches enable row level security;

drop policy if exists "users manage their own saved searches" on public.saved_searches;
create policy "users manage their own saved searches"
  on public.saved_searches for all
  using (auth.uid() = profile_id)
  with check (auth.uid() = profile_id);

create index if not exists saved_searches_profile_idx on public.saved_searches(profile_id);

-- ============================================================
-- 2. USER PREFERENCES (lightweight — default filters, not account settings)
-- ============================================================
alter table public.profiles add column if not exists preferences jsonb not null default '{}'::jsonb;
