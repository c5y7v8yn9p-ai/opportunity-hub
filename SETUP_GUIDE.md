# Setup Guide — Daily Opportunities

Everything here is free and runs on autopilot once it's set up. No servers to
pay for, no coding — just clicking through some settings pages. Budget about
30–40 minutes.

## What changed from the original plan
Reddit and X/Twitter are NOT in this version. As of 2026, X has no free tier
at all (everyone pays per API call), and Reddit's free tier explicitly bans
commercial use — a paid product on it needs a license starting around
$12,000/month. So this build uses three sources that ARE free and legal to
build a paid product on: Hacker News (fully open, no key), Google News RSS
(public syndication feed, no key), and YouTube (free quota, one API key).
Reddit/X can be added later once there's revenue to license them properly.

---

## Step 1 — Push this folder to GitHub (10 min)

You already have a GitHub account and VS Code, so:

1. Open this `opportunity-hub` folder in VS Code (File → Open Folder).
2. Go to the Source Control tab (the branch icon on the left sidebar).
3. Click "Publish to GitHub" → choose **Public** repository → name it
   `opportunity-hub`.
   - VS Code handles `git init`, the first commit, and the push for you.
4. Confirm it worked: go to github.com, open your profile, you should see
   the new `opportunity-hub` repo with these files in it.

---

## Step 2 — Get a free YouTube API key (5 min)

1. Go to https://console.cloud.google.com
2. Create a new project (top left dropdown → New Project) — call it
   `opportunity-hub`.
3. In the search bar, type "YouTube Data API v3" → open it → click **Enable**.
4. Go to "APIs & Services" → "Credentials" → **Create Credentials** →
   **API key**.
5. Copy the key. It looks like `AIzaSy...`.

Do NOT paste this key into any chat, including this one. It goes straight
into GitHub in the next step.

---

## Step 3 — Add the key as a GitHub Secret (3 min)

1. On your `opportunity-hub` GitHub repo page, go to **Settings** → **Secrets
   and variables** → **Actions**.
2. Click **New repository secret**.
3. Name: `YOUTUBE_API_KEY`
4. Value: paste the key from Step 2.
5. Click **Add secret**.

This keeps the key private — it's only ever used inside GitHub's servers
when the scraper runs, never exposed anywhere.

---

## Step 4 — Turn on GitHub Pages (2 min)

1. On the repo page, go to **Settings** → **Pages**.
2. Under "Build and deployment" → Source: **Deploy from a branch**.
3. Branch: `main`, folder: **/docs**. Click **Save**.
4. GitHub will show you a URL like
   `https://<your-username>.github.io/opportunity-hub/` — that's your live
   site. It may take a minute or two to go live the first time.

---

## Step 5 — Run the scraper once manually (2 min)

The scraper is scheduled to run automatically every morning, but the site
will look empty until it's run at least once. Trigger it by hand:

1. On the repo page, go to the **Actions** tab.
2. Click "Daily Opportunity Scrape" in the left list.
3. Click **Run workflow** → **Run workflow** (the green button).
4. Wait ~30 seconds, refresh — it should show a green checkmark.
5. Visit your GitHub Pages URL from Step 4 — you should now see real
   opportunities.

From now on it runs automatically every day at 6 AM IST. You don't have to
do anything.

---

## Step 6 — Set up payment collection (10 min, optional until you have users)

No backend needed for this. Razorpay lets you create a payment link with
zero code:

1. Go to https://razorpay.com and sign up (email, phone, basic business
   details). Approval is usually quick but can take a bit longer if they
   ask for KYC documents.
2. In the Razorpay dashboard: **Payment Links** → **Create Payment Link**.
3. Set amount to ₹10 (or whatever you land on), description "Daily
   Opportunities subscription."
4. Copy the generated link (looks like `https://rzp.io/l/xxxxx`).
5. Open `docs/index.html` in VS Code, find the line that says
   `PASTE_YOUR_RAZORPAY_PAYMENT_LINK_HERE` and replace it with your link.
6. Save, then in VS Code's Source Control tab: commit the change and push.
   Your live site updates automatically within a minute.

Note: a single static payment link doesn't automatically track *who* paid or
gate content behind a login — for a real subscription (auto-renewing,
per-user access) you'd eventually want a small backend and something like
Firebase for user accounts. That's a fine Phase 2 once you have people
actually clicking "Subscribe" — no point building login/auth before you know
anyone wants the product.

---

## What to do this week

1. Finish Steps 1–5 (the automated, free part) and get the site live.
2. Watch what the scraper picks up for a few days. If a lot of results feel
   off-topic, open `scraper.py`, look at the `SIGNAL_WORDS`, `HN_QUERIES`,
   and `GOOGLE_NEWS_QUERIES` lists near the top, and adjust the words —
   these are plain lists, easy to edit even without coding experience.
3. Share the GitHub Pages link with 10–20 people (WhatsApp, a relevant
   subreddit/Telegram group, wherever your first real users are) and see if
   anyone actually wants the paid version before building anything further.
