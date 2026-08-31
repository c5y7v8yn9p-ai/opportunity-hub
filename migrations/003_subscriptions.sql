-- OpportunityHub V2.1 — Razorpay subscription tracking.
-- Run once in Supabase Dashboard -> SQL Editor -> New query, after
-- migrations/002_v2_marketplace.sql has already been run.
--
-- This does NOT touch the profiles/opportunities tables — it's a fully
-- separate, additive table. Only the two new Edge Functions (using the
-- service_role key) are ever allowed to write to it; regular users can
-- only read their own row, so nobody can grant themselves a subscription
-- by calling the Supabase REST API directly.

create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  razorpay_customer_id text,
  razorpay_subscription_id text unique,
  plan_id text,
  -- Razorpay subscription lifecycle: created, authenticated, active,
  -- pending, halted, cancelled, completed, expired
  status text not null default 'created',
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_user_id_idx on public.subscriptions(user_id);
create index if not exists subscriptions_razorpay_id_idx on public.subscriptions(razorpay_subscription_id);

alter table public.subscriptions enable row level security;

-- Users can see their own subscription row(s) — that's it. No insert,
-- update, or delete policy exists for anon/authenticated roles, so the
-- only way this table changes is through the two Edge Functions running
-- with the service_role key (which bypasses RLS entirely).
create policy "users can view their own subscription"
  on public.subscriptions for select
  using (auth.uid() = user_id);

-- Convenience view: is a given user an active subscriber right now?
-- (active status AND current billing period hasn't ended yet)
create or replace view public.active_subscribers as
  select user_id
  from public.subscriptions
  where status = 'active'
    and (current_period_end is null or current_period_end > now());
