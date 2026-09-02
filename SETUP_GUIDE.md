# Seeker — Setup Guide

This is now a real full-stack site: accounts, a live opportunity feed (auto-scraped
+ user-submitted), direct messaging, ratings, and paid courses. It needs a few
one-time setup steps before it's live. None of them require writing more code —
just creating accounts and pasting a few keys into two files.

Total cost to run: **$0/month** at small scale (Supabase free tier + GitHub Pages
free + GitHub Actions free minutes). Razorpay takes its standard per-transaction
fee only when money actually moves — nothing upfront.

---

## Stage 1 — Push this project to GitHub

1. Create a new **public** repository on GitHub (Settings will let you flip it to
   private later if you want, but GitHub Pages on a private repo needs a paid plan).
2. Push everything in this folder to that repo's `main` branch.
3. In the repo: **Settings -> Pages -> Build and deployment -> Source: Deploy from
   a branch -> Branch: `main`, folder: `/docs`**. Save. GitHub gives you a URL like
   `https://yourname.github.io/your-repo/` — that's your live site once the later
   stages are done.

---

## Stage 2 — Create your Supabase project (the database + accounts backend)

1. Go to supabase.com and create a free account, then **New Project**. Pick any
   name/region, set a database password (save it somewhere — you likely won't
   need it again, Supabase manages connections for you).
2. Once the project finishes provisioning, open **SQL Editor -> New query**,
   paste in the entire contents of `supabase-schema.sql` from this repo, and
   click **Run**. This creates every table (profiles, opportunities, messages,
   ratings, courses) and all the access-control rules in one shot.
3. Go to **Database -> Replication**, find the `messages` table under
   `supabase_realtime`, and toggle it **on** (the schema script also tries to do
   this automatically — if it already shows as on, you're set). This is what
   makes the Messages page update live instead of needing a refresh.
4. Go to **Authentication -> Providers** and confirm **Email** is enabled (it is
   by default). Optional: under **Authentication -> Settings**, you can turn off
   "Confirm email" while you're testing, so signups work instantly without
   clicking an email link — just remember to turn it back on before real users
   sign up.

---

## Stage 3 — Connect the site to Supabase

1. In your Supabase project: **Settings -> API**. Copy the **Project URL** and
   the **`anon` `public`** key.
2. Open `docs/js/config.js` in this repo and paste them in:
   ```js
   window.OPPORTUNITY_HUB_CONFIG = {
     SUPABASE_URL: "https://xxxxxxxx.supabase.co",
     SUPABASE_ANON_KEY: "eyJ...",
   };
   ```
3. Commit and push. The `anon` key is *meant* to be public — every Supabase
   browser app ships it. Access is actually controlled by the Row Level
   Security policies the schema script created (e.g. "only the sender/recipient
   can read a message").
4. **Do not** put the other key — `service_role` — anywhere in `docs/`. That one
   bypasses all the access rules and is only for the scraper (next stage).

---

## Stage 4 — Turn on the daily automated scraper

The scraper (`scraper.py`) pulls fresh opportunity signals from Hacker News,
Google News, and (optionally) YouTube every day and inserts them straight into
your Supabase `opportunities` table. A GitHub Actions workflow
(`.github/workflows/daily-scrape.yml`) is already set up to run it automatically
— you just need to give it credentials:

1. In Supabase: **Settings -> API**, copy the **`service_role`** key (marked
   secret — never share this one or commit it to the repo).
2. In your GitHub repo: **Settings -> Secrets and variables -> Actions -> New
   repository secret**. Add:
   - `SUPABASE_URL` — same project URL as above
   - `SUPABASE_SERVICE_ROLE_KEY` — the service_role key
   - `YOUTUBE_API_KEY` — optional; only needed if you want YouTube results too
     (free to get from Google Cloud Console -> enable "YouTube Data API v3" ->
     create an API key)
3. That's it — the workflow runs daily at 03:00 UTC on its own. To test it right
   now instead of waiting: repo -> **Actions -> Daily opportunity scrape -> Run
   workflow**.

---

## Stage 5 — Set up payments (Razorpay)

Two separate things use Razorpay, and both are things *you* set up — I can't
create a Razorpay account or generate payment links on your behalf, since that
needs your own login and bank details.

**A) The ₹10/day feed subscription** (paywall box on the homepage):
1. Create a free account at razorpay.com, complete their KYC (needed before you
   can actually receive payouts).
2. Dashboard -> **Payment Links -> New Payment Link**. Set it to ₹10, recurring
   if you want a subscription rather than one-time (Razorpay Subscriptions is a
   separate, slightly more involved product than Payment Links — Payment Links
   is the fastest way to get *something* live; you can upgrade later).
3. Copy the link, paste it into `docs/index.html` in place of
   `PASTE_YOUR_RAZORPAY_PAYMENT_LINK_HERE`.

**B) Course sales:** each course creator pastes their *own* Razorpay Payment
Link when they publish a course on the Courses page — the site never touches
course payments directly, it just links out to whatever payment link the
creator provided. That means each creator needs their own Razorpay account.

---

## Stage 6 — Test it end to end

Once Stages 1-4 are done (Stage 5 can wait), open your GitHub Pages URL and:

1. Sign up for an account (top-right / nav "Log In / Sign Up").
2. Post a test opportunity — confirm it shows up in the feed.
3. Open the site in a second browser (or incognito), sign up as a second user,
   message the first user, and confirm the message and unread dot show up.
4. Leave a rating on a profile and confirm the star average updates.
5. Publish a test course with a placeholder payment link and confirm it lists.
6. Trigger the scraper manually (Stage 4, step 3) and confirm scraped items
   appear in the feed within a minute or two.

---

## What you're now responsible for (this is a real marketplace)

Worth being upfront about, since this changes the moment you have real users:

- **Moderation.** Anyone can post an opportunity or a course. Nothing here
  automatically screens for scams, spam, or fake listings — that's a manual
  review process you'd run (e.g. periodically scanning new postings in the
  Supabase table editor, or adding a "report" button later).
- **Payment disputes and refunds.** Course payments go straight to each
  creator's own Razorpay account — refund requests and chargebacks are between
  the buyer and that creator's Razorpay dashboard, not something this site's
  code handles.
- **User data.** Emails and messages are real personal data now, stored in your
  Supabase project. Have a plain-language privacy note somewhere on the site if
  you're operating in a region that requires one (India's DPDP Act, GDPR if you
  get EU users, etc.) — this is a legal question worth a real lawyer's five
  minutes, not something to guess at.
- **Supabase free tier limits** (as of now): 500MB database, 50,000 monthly
  active auth users, 2GB file storage, project pauses after 1 week fully
  inactive (a visit or an Action run resets that clock). Fine for a while;
  worth knowing before you're surprised by it.
