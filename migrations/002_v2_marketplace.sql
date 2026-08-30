-- OpportunityHub V2 — additive migration for the global marketplace rebuild.
-- Safe to run alongside the existing schema: only ADDS tables/columns, never
-- drops or renames anything, so nothing existing (auth, current postings,
-- messages, ratings, courses) breaks. Run once in SQL Editor -> New query.

-- ============================================================
-- 1. INDUSTRIES  (preset taxonomy + user-suggested custom industries)
-- ============================================================
create table if not exists public.industries (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  slug text not null unique,
  description text default '',
  is_custom boolean not null default false,
  status text not null default 'approved' check (status in ('approved','pending_review','rejected','merged')),
  merged_into uuid references public.industries(id),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz default now()
);

alter table public.industries enable row level security;

drop policy if exists "industries visible if approved or own" on public.industries;
create policy "industries visible if approved or own"
  on public.industries for select
  using (status = 'approved' or created_by = auth.uid());

drop policy if exists "users can suggest industries" on public.industries;
create policy "users can suggest industries"
  on public.industries for insert
  with check (auth.uid() = created_by and status = 'pending_review');

insert into public.industries (name, slug, is_custom, status) values
  ('Technology','technology',false,'approved'),
  ('Software','software',false,'approved'),
  ('AI','ai',false,'approved'),
  ('Construction','construction',false,'approved'),
  ('Manufacturing','manufacturing',false,'approved'),
  ('Agriculture','agriculture',false,'approved'),
  ('Healthcare','healthcare',false,'approved'),
  ('Education','education',false,'approved'),
  ('Hospitality','hospitality',false,'approved'),
  ('Retail','retail',false,'approved'),
  ('Transportation','transportation',false,'approved'),
  ('Logistics','logistics',false,'approved'),
  ('Finance','finance',false,'approved'),
  ('Marketing','marketing',false,'approved'),
  ('Sales','sales',false,'approved'),
  ('Media','media',false,'approved'),
  ('Film','film',false,'approved'),
  ('Photography','photography',false,'approved'),
  ('Design','design',false,'approved'),
  ('Beauty','beauty',false,'approved'),
  ('Personal Services','personal-services',false,'approved'),
  ('Legal','legal',false,'approved'),
  ('Professional Services','professional-services',false,'approved'),
  ('Science','science',false,'approved'),
  ('Research','research',false,'approved'),
  ('Energy','energy',false,'approved'),
  ('Tourism','tourism',false,'approved'),
  ('Sports','sports',false,'approved'),
  ('Entertainment','entertainment',false,'approved'),
  ('Government','government',false,'approved'),
  ('Nonprofit','nonprofit',false,'approved'),
  ('Other','other',false,'approved')
on conflict (slug) do nothing;

-- ============================================================
-- 2. OPPORTUNITIES — expand existing table (additive columns only)
-- ============================================================
alter table public.opportunities
  add column if not exists industry_id uuid references public.industries(id),
  add column if not exists opportunity_type text default 'gig'
    check (opportunity_type in ('full_time','part_time','contract','freelance','gig','one_time_task','project','seasonal','internship','apprenticeship','volunteer','service_request')),
  add column if not exists work_mode text default 'local'
    check (work_mode in ('local','remote','hybrid','relocation','travel')),
  add column if not exists country text,
  add column if not exists region text,
  add column if not exists city text,
  add column if not exists latitude double precision,
  add column if not exists longitude double precision,
  add column if not exists pay_min integer,
  add column if not exists pay_max integer,
  add column if not exists pay_currency text default 'INR',
  add column if not exists experience_level text default 'any'
    check (experience_level in ('no_experience','beginner','intermediate','advanced','any')),
  add column if not exists skills jsonb not null default '[]'::jsonb,
  add column if not exists language_requirements jsonb not null default '[]'::jsonb,
  add column if not exists availability text default '',
  add column if not exists start_date date,
  add column if not exists end_date date,
  add column if not exists work_authorization text default '',
  add column if not exists source_id text,
  add column if not exists last_verified_at timestamptz default now(),
  add column if not exists expires_at timestamptz,
  add column if not exists status text not null default 'active'
    check (status in ('draft','pending_review','active','paused','filled','expired','removed','reported'));

create index if not exists opportunities_country_idx on public.opportunities(country);
create index if not exists opportunities_industry_idx on public.opportunities(industry_id);
create index if not exists opportunities_status_idx on public.opportunities(status);
create index if not exists opportunities_geo_idx on public.opportunities(latitude, longitude);
create index if not exists opportunities_work_mode_idx on public.opportunities(work_mode);

-- ============================================================
-- 3. CAPABILITIES  (a profile's skills, each with a trust level)
-- ============================================================
create table if not exists public.capabilities (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  skill text not null,
  proficiency text not null default 'intermediate'
    check (proficiency in ('beginner','intermediate','experienced','expert')),
  trust_level text not null default 'self_declared'
    check (trust_level in ('self_declared','evidence','verified')),
  evidence_url text,
  created_at timestamptz default now(),
  unique (profile_id, skill)
);

alter table public.capabilities enable row level security;

drop policy if exists "capabilities are publicly readable" on public.capabilities;
create policy "capabilities are publicly readable"
  on public.capabilities for select
  using (true);

drop policy if exists "users manage their own capabilities" on public.capabilities;
create policy "users manage their own capabilities"
  on public.capabilities for all
  using (auth.uid() = profile_id)
  with check (auth.uid() = profile_id);

-- ============================================================
-- 4. SAVED OPPORTUNITIES
-- ============================================================
create table if not exists public.saved_opportunities (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  opportunity_id uuid not null references public.opportunities(id) on delete cascade,
  created_at timestamptz default now(),
  unique (profile_id, opportunity_id)
);

alter table public.saved_opportunities enable row level security;

drop policy if exists "users manage their own saved opportunities" on public.saved_opportunities;
create policy "users manage their own saved opportunities"
  on public.saved_opportunities for all
  using (auth.uid() = profile_id)
  with check (auth.uid() = profile_id);

-- ============================================================
-- 5. REPORTS  (fraud / scam / abuse reporting)
-- ============================================================
create table if not exists public.reports (
  id uuid primary key default gen_random_uuid(),
  opportunity_id uuid references public.opportunities(id) on delete cascade,
  reporter_id uuid references public.profiles(id) on delete set null,
  reason text not null check (reason in
    ('scam','fake_job','misleading_salary','application_fee','illegal_activity','harassment','impersonation','duplicate','expired','other')),
  details text default '',
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  created_at timestamptz default now()
);

alter table public.reports enable row level security;

drop policy if exists "users can file reports" on public.reports;
create policy "users can file reports"
  on public.reports for insert
  with check (auth.uid() = reporter_id);

drop policy if exists "users can see their own reports" on public.reports;
create policy "users can see their own reports"
  on public.reports for select
  using (auth.uid() = reporter_id);
