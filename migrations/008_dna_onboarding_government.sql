-- Foundation phase of the "Master V2/V3" reframe: OpportunityHub moves from
-- "here's everything happening" to "here's what matters to you." This
-- migration adds the storage this needs, without touching anything that
-- already works:
--
--   profiles.dna / intents / onboarding_completed / onboarding_skipped
--     -> the "User Opportunity DNA" the onboarding flow writes, and the
--        homepage/feed read to personalize.
--   opportunities.government_level / department
--     -> lets Government be a first-class filterable category instead of
--        just another industry tag.
--
-- All additive, all nullable/defaulted — nothing existing breaks if left
-- unset. Paste into Supabase Dashboard -> SQL Editor and run.

-- ============================================================
-- 1. USER OPPORTUNITY DNA
-- ============================================================
alter table public.profiles add column if not exists dna jsonb not null default '{}'::jsonb;
alter table public.profiles add column if not exists intents jsonb not null default '[]'::jsonb;
alter table public.profiles add column if not exists onboarding_completed boolean not null default false;
-- Distinguishes "explicitly chose Explore without personalization" from
-- "never saw onboarding yet", so a skipper isn't nagged on every visit.
alter table public.profiles add column if not exists onboarding_skipped boolean not null default false;

-- ============================================================
-- 2. GOVERNMENT AS A FIRST-CLASS CATEGORY
-- ============================================================
alter table public.opportunities add column if not exists government_level text
  check (government_level in (
    'central','state','psu','railways','banking','defence','police',
    'teaching','healthcare','administrative','other'
  ));
alter table public.opportunities add column if not exists department text;

create index if not exists opportunities_government_level_idx
  on public.opportunities(government_level) where government_level is not null;
