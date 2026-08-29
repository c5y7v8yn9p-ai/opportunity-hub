-- OpportunityHub — full schema + Row Level Security policies
-- Run this ONCE in your Supabase project: Dashboard -> SQL Editor -> New query -> paste -> Run
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE / DROP POLICY IF EXISTS guards.

-- ============================================================
-- 1. PROFILES  (one row per auth.users row)
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  bio text default '',
  location text default '',
  avatar_url text default '',
  rating_avg numeric(3,2) default 0,
  rating_count integer default 0,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles are publicly readable" on public.profiles;
create policy "profiles are publicly readable"
  on public.profiles for select
  using (true);

drop policy if exists "users can insert their own profile" on public.profiles;
create policy "users can insert their own profile"
  on public.profiles for insert
  with check (auth.uid() = id);

drop policy if exists "users can update their own profile" on public.profiles;
create policy "users can update their own profile"
  on public.profiles for update
  using (auth.uid() = id);

-- Auto-create a profile row whenever a new auth user signs up
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1) || '_' || substr(new.id::text, 1, 4))
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- 2. OPPORTUNITIES  (scraped feed items + user-submitted postings)
-- ============================================================
create table if not exists public.opportunities (
  id uuid primary key default gen_random_uuid(),
  source_type text not null default 'user' check (source_type in ('scraped', 'user')),
  source text default '',              -- "Hacker News" / "News" / "YouTube" / "User Posting"
  title text not null,
  body text default '',
  opp_type text default 'General',     -- Trading / Tech / E-commerce / Service / General
  location text default '',
  money_mentioned text default '',
  url text,
  engagement integer default 0,
  posted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz default now()
);

-- Dedup key: scraped items are deduped by source url; user postings always get a fresh row
create unique index if not exists opportunities_url_unique
  on public.opportunities (url)
  where url is not null and source_type = 'scraped';

alter table public.opportunities enable row level security;

drop policy if exists "opportunities are publicly readable" on public.opportunities;
create policy "opportunities are publicly readable"
  on public.opportunities for select
  using (true);

drop policy if exists "authenticated users can post opportunities" on public.opportunities;
create policy "authenticated users can post opportunities"
  on public.opportunities for insert
  with check (auth.uid() = posted_by and source_type = 'user');

drop policy if exists "users can edit their own postings" on public.opportunities;
create policy "users can edit their own postings"
  on public.opportunities for update
  using (auth.uid() = posted_by);

drop policy if exists "users can delete their own postings" on public.opportunities;
create policy "users can delete their own postings"
  on public.opportunities for delete
  using (auth.uid() = posted_by);

-- Note: scraped rows are inserted by the daily GitHub Actions job using the
-- SERVICE ROLE key, which bypasses RLS entirely — that key must never be
-- used in browser-facing code, only in the scraper's server-side script.

-- ============================================================
-- 3. MESSAGES  (direct messages between two users)
-- ============================================================
create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  opportunity_id uuid references public.opportunities(id) on delete set null,
  body text not null,
  read boolean default false,
  created_at timestamptz default now()
);

create index if not exists messages_participants_idx
  on public.messages (sender_id, recipient_id, created_at);

alter table public.messages enable row level security;

drop policy if exists "participants can read their messages" on public.messages;
create policy "participants can read their messages"
  on public.messages for select
  using (auth.uid() = sender_id or auth.uid() = recipient_id);

drop policy if exists "users can send messages as themselves" on public.messages;
create policy "users can send messages as themselves"
  on public.messages for insert
  with check (auth.uid() = sender_id and sender_id <> recipient_id);

drop policy if exists "recipients can mark messages read" on public.messages;
create policy "recipients can mark messages read"
  on public.messages for update
  using (auth.uid() = recipient_id);

-- ============================================================
-- 4. RATINGS  (one user rates another, optionally tied to an opportunity)
-- ============================================================
create table if not exists public.ratings (
  id uuid primary key default gen_random_uuid(),
  rater_id uuid not null references public.profiles(id) on delete cascade,
  rated_id uuid not null references public.profiles(id) on delete cascade,
  opportunity_id uuid references public.opportunities(id) on delete set null,
  stars integer not null check (stars between 1 and 5),
  comment text default '',
  created_at timestamptz default now()
);

-- One rating per (rater, rated) pair overall — the UI rates a *user*, not a
-- specific opportunity (opportunity_id is optional context, usually null),
-- so uniqueness has to key off just the two people or a null opportunity_id
-- would let the same rater rate the same person unlimited times.
create unique index if not exists ratings_rater_rated_unique
  on public.ratings (rater_id, rated_id);

alter table public.ratings enable row level security;

drop policy if exists "ratings are publicly readable" on public.ratings;
create policy "ratings are publicly readable"
  on public.ratings for select
  using (true);

drop policy if exists "users can rate others but not themselves" on public.ratings;
create policy "users can rate others but not themselves"
  on public.ratings for insert
  with check (auth.uid() = rater_id and rater_id <> rated_id);

-- Keep profiles.rating_avg / rating_count in sync automatically
create or replace function public.refresh_rating_stats()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  target uuid := coalesce(new.rated_id, old.rated_id);
begin
  update public.profiles p
  set rating_count = s.cnt,
      rating_avg = s.avg_stars
  from (
    select count(*) as cnt, coalesce(avg(stars), 0) as avg_stars
    from public.ratings where rated_id = target
  ) s
  where p.id = target;
  return null;
end;
$$;

drop trigger if exists on_rating_change on public.ratings;
create trigger on_rating_change
  after insert or update or delete on public.ratings
  for each row execute function public.refresh_rating_stats();

-- ============================================================
-- 5. COURSES  (paid courses sold via a Razorpay Payment Link)
-- ============================================================
create table if not exists public.courses (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.profiles(id) on delete cascade,
  title text not null,
  description text default '',
  price_inr integer not null check (price_inr >= 0),
  payment_link text not null,   -- Razorpay Payment Link URL for this course
  created_at timestamptz default now()
);

alter table public.courses enable row level security;

drop policy if exists "courses are publicly readable" on public.courses;
create policy "courses are publicly readable"
  on public.courses for select
  using (true);

drop policy if exists "creators can add their own courses" on public.courses;
create policy "creators can add their own courses"
  on public.courses for insert
  with check (auth.uid() = creator_id);

drop policy if exists "creators can edit their own courses" on public.courses;
create policy "creators can edit their own courses"
  on public.courses for update
  using (auth.uid() = creator_id);

drop policy if exists "creators can delete their own courses" on public.courses;
create policy "creators can delete their own courses"
  on public.courses for delete
  using (auth.uid() = creator_id);

-- ============================================================
-- 6. REALTIME  (so messages.html gets live updates)
-- ============================================================
-- In Supabase Dashboard: Database -> Replication -> supabase_realtime,
-- toggle ON for the "messages" table (or let the block below do it — it's
-- safe to re-run, unlike a bare ALTER PUBLICATION ... ADD TABLE which errors
-- on a second run if the table is already a publication member).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end;
$$;
