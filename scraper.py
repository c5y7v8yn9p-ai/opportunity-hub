#!/usr/bin/env python3
"""
Daily Opportunity Scraper

Pulls real, currently-being-discussed side-hustle / business-opportunity
signals AND real job/gig board listings from sources that are free to use
AND legal to build a paid product on top of:

  - Hacker News (Algolia API)   -> no key needed, no commercial restriction
  - Google News RSS (keyword)   -> public syndication feed, no key needed
  - YouTube Data API            -> free quota, needs YOUTUBE_API_KEY (optional;
                                     script still runs without it, just skips)
  - Remotive API                -> free, public, no key needed, remote jobs
  - Arbeitnow Job Board API     -> free, public, no key needed, job listings
  - RemoteOK API                -> free, public, no key needed, remote jobs
                                     (RemoteOK's API asks for a descriptive
                                     User-Agent and attribution, both honored)

Reddit and X/Twitter are deliberately NOT included: neither has a free tier
that a paid subscription product is allowed to run on. LinkedIn, Indeed,
Craigslist and Upwork are also deliberately NOT scraped: LinkedIn and Indeed's
terms of service explicitly prohibit scraping (LinkedIn has won litigation
over exactly this), Upwork has no public opportunities API, and Craigslist
blocks automated access. Only sources that are both free and ToS-compliant
are used here.

Where results go:
  - Inserted directly into the Supabase "opportunities" table (source_type
    = 'scraped'), using the SERVICE ROLE key, so they show up in the live
    feed and map at docs/index.html alongside user-submitted postings.
  - Also written to docs/opportunities.json as a local debug/offline copy
    (the live site does NOT read this file anymore, it's just useful for
    testing the scraper without hitting Supabase).

Required env vars (set as GitHub Actions secrets — see SETUP_GUIDE.md):
  SUPABASE_URL              - your project URL
  SUPABASE_SERVICE_ROLE_KEY - service_role key (NOT the anon key — this one
                               bypasses Row Level Security, so it must only
                               ever be used here, server-side, never in the
                               browser code under docs/)
  YOUTUBE_API_KEY            - optional
"""
import os
import re
import sys
import json
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone, timedelta

import requests

YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

DEBUG_OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "opportunities.json")

# A descriptive User-Agent, as RemoteOK's API docs ask public consumers to send.
USER_AGENT = "OpportunityHubBot/1.0 (+https://github.com/c5y7v8yn9p-ai/opportunity-hub; daily non-commercial-scale job aggregation)"

SIGNAL_WORDS = [
    "opportunity", "earning", "profit", "side hustle",
    "import", "export", "business idea", "launched", "bootstrapped",
    "side income", "passive income", "reseller",
    "side project turned into", "first customer", "no funding",
    "solo founder", "zero to", "self-funded", "one person business",
]

LOCATIONS = [
    "India", "Philippines", "Kenya", "Vietnam", "Brazil", "Indonesia",
    "Egypt", "Nigeria", "Pakistan", "Bangladesh",
]

GOOGLE_NEWS_QUERIES = [
    "side hustle opportunity",
    "small business idea profitable",
    "import export business started",
    "bootstrapped startup revenue",
]

HN_QUERIES = ["side hustle", "bootstrapped", "started a business", "side income", "import export"]

# Real job-board API queries — these return actual listings, not text to
# signal-score, so unlike HN/Google News every result here is kept.
JOB_BOARD_QUERIES = ["remote", "freelance", "part time", "entry level"]

# Daily news dashboard — general business/startup/employment headlines,
# NOT run through score_signal() (that filter is tuned for personal
# "someone did a side hustle" anecdotes, too narrow for general news).
NEWS_DASHBOARD_QUERIES = {
    "business": ["business news india", "indian economy business"],
    "startup": ["startup funding india", "indian startup news"],
    "employment": ["jobs employment hiring india", "layoffs hiring india"],
}
NEWS_ITEMS_PER_CATEGORY = 8

# Outlets we recognize as established news organizations — shown as a
# "verified" source-quality badge on the /signals page. This is a coarse,
# hand-maintained allowlist, not a real credibility system; anything not
# listed here just shows as "unverified" (which does NOT mean untrustworthy,
# only "we don't recognize this outlet yet").
KNOWN_QUALITY_SOURCES = {
    "the times of india", "times of india", "the hindu", "hindustan times",
    "business standard", "moneycontrol.com", "moneycontrol", "the economic times",
    "economic times", "livemint", "mint", "financial express", "the tribune",
    "reuters", "press trust of india", "pti", "ani", "bloomberg", "bloombergquint",
    "cnbc", "cnbc-tv18", "the indian express", "indian express", "ndtv",
    "the wire", "scroll.in", "yourstory", "inc42", "entrackr", "vccircle",
    "forbes india", "business today", "outlook business", "the print",
    "millenniumpost", "storyboard18",
}

# Keyword -> signal_type classification. Checked in this order (first match
# wins) against the lowercased title+summary. Deliberately simple/rule-based,
# not ML — good enough to sort "TCS wins Rs 2,000cr deal" from "Oracle may
# cut jobs" without pretending to be smarter than it is.
SIGNAL_TYPE_RULES = [
    ("funding", ["raises", "funding round", "pre-seed", "pre series", "series a",
                 "series b", "series c", "seed round", "crore in", "million in",
                 "valuation", "venture capital", "investors"]),
    ("layoff", ["layoff", "lay off", "laid off", "job cuts", "workforce reduction",
                "retrench"]),
    ("acquisition", ["acquire", "acquisition", "acquires", "acquired", "merger",
                      "to buy", "takeover"]),
    ("hiring", ["hiring", "recruitment", "vacancy", "vacancies", "job openings",
                "walk-in interview", "recruitment 2026", "recruitment drive"]),
    ("expansion", ["expansion", "expands", "expanding", "to open", "new plant",
                    "new facility", "scale up", "scale manufacturing"]),
    ("launch", ["launches", "launch of", "unveils", "rolls out", "introduces"]),
    ("regulation", ["rbi", "sebi", "regulation", "compliance", "ministry",
                     "policy", "notification", "gazette"]),
    ("government", ["government", "govt", "india post", "psu", "public sector",
                     "cabinet approves"]),
    ("market", ["sensex", "nifty", "stock market", "shares", "stocks", "ipo",
                 "market cap", "rupee", "gdp"]),
]


def classify_signal(title, summary):
    text = f"{title} {summary}".lower()
    for signal_type, keywords in SIGNAL_TYPE_RULES:
        if any(kw in text for kw in keywords):
            return signal_type
    return "business"


def guess_source_quality(source_name):
    return "verified" if (source_name or "").strip().lower() in KNOWN_QUALITY_SOURCES else "unverified"


def guess_company(title):
    """Best-effort: the capitalized word/phrase before a common signal verb
    ('X Raises...', 'Y Acquires...', 'Z Launches...'). Returns None rather
    than guessing wrong — this is a nice-to-have, not load-bearing."""
    m = re.match(
        r"^([A-Z][A-Za-z0-9&.\-]*(?:\s+[A-Z][A-Za-z0-9&.\-]*){0,3})\s+"
        r"(raises|acquires|launches|unveils|expands|hires|lays off|wins|signs|"
        r"partners|opens|closes|cuts|announces)",
        title.strip(),
    )
    return m.group(1).strip() if m else None


def normalize_title(title):
    """Collapse near-duplicate headlines from different outlets down to a
    comparable key: lowercase, drop the trailing ' - Source Name', strip
    punctuation/whitespace differences."""
    t = re.sub(r"\s+-\s+[^-]{2,40}$", "", title or "")  # strip " - Outlet"
    t = re.sub(r"[^a-z0-9 ]", " ", t.lower())
    t = re.sub(r"\s+", " ", t).strip()
    return t


def score_opportunity(it):
    """Rule-based 0-100 'Opportunity Score' — freshness/completeness/
    credibility proxies, deliberately simple and explainable. NOT an AI
    score; never label it as one in the UI."""
    score = 20  # baseline: it made it into the feed at all
    if it.get("pay_min") or it.get("money_mentioned"):
        score += 20
    if it.get("geo_city") or it.get("location"):
        score += 15
    if it.get("industry_guess"):
        score += 15
    if it.get("opportunity_type") and it.get("opportunity_type") not in (None, "gig", "project"):
        score += 10
    engagement = it.get("engagement") or 0
    score += min(15, engagement // 20)  # up to +15 for well-engaged HN/source items
    if len(it.get("title") or "") > 12:
        score += 5
    return max(0, min(100, score))



def extract_details(text):
    details = {"location": None, "money_mentioned": None, "opp_type": "General"}
    for loc in LOCATIONS:
        if loc.lower() in text.lower():
            details["location"] = loc
            break
    money = re.findall(r"(?:₹|Rs\.?|\$)\s?[\d,]+(?:\.\d+)?", text)
    if money:
        details["money_mentioned"] = money[0]
    lower = text.lower()
    if "import" in lower or "export" in lower:
        details["opp_type"] = "Trading / Import-Export"
    elif "app" in lower or "software" in lower or "saas" in lower:
        details["opp_type"] = "Tech / Software"
    elif "sell" in lower or "reseller" in lower or "ecommerce" in lower or "e-commerce" in lower:
        details["opp_type"] = "E-commerce / Reselling"
    elif "service" in lower or "freelance" in lower or "consult" in lower:
        details["opp_type"] = "Service / Freelance"
    return details


def score_signal(text):
    lower = text.lower()
    return sum(1 for w in SIGNAL_WORDS if w in lower)


def strip_html(raw):
    return re.sub("<[^<]+?>", " ", raw or "").strip()


def fetch_hn():
    items = []
    for q in HN_QUERIES:
        try:
            r = requests.get(
                "https://hn.algolia.com/api/v1/search_by_date",
                params={"query": q, "tags": "story", "hitsPerPage": 20},
                timeout=15,
            )
            r.raise_for_status()
            for hit in r.json().get("hits", []):
                title = hit.get("title") or ""
                text = hit.get("story_text") or ""
                combined = f"{title}. {text}"
                if score_signal(combined) == 0:
                    continue
                items.append({
                    "source": "Hacker News",
                    "title": title,
                    "body": (text or title)[:280],
                    "engagement": (hit.get("points") or 0) + (hit.get("num_comments") or 0),
                    "url": f"https://news.ycombinator.com/item?id={hit.get('objectID')}",
                    "work_mode": "local",
                    "opportunity_type": "project",
                    **extract_details(combined),
                })
        except Exception as e:
            print(f"[HN] skipped query '{q}': {e}", file=sys.stderr)
    return items


def fetch_google_news():
    items = []
    for q in GOOGLE_NEWS_QUERIES:
        url = f"https://news.google.com/rss/search?q={requests.utils.quote(q)}&hl=en-IN&gl=IN&ceid=IN:en"
        try:
            r = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
            r.raise_for_status()
            root = ET.fromstring(r.content)
            for item in root.findall(".//item")[:15]:
                title = (item.findtext("title") or "").strip()
                desc_raw = (item.findtext("description") or "").strip()
                desc = re.sub("<[^<]+?>", "", desc_raw)
                link = (item.findtext("link") or "").strip()
                combined = f"{title}. {desc}"
                if score_signal(combined) == 0:
                    continue
                items.append({
                    "source": "News",
                    "title": title,
                    "body": desc[:280],
                    "engagement": 0,
                    "url": link,
                    "work_mode": "local",
                    "opportunity_type": "project",
                    **extract_details(combined),
                })
        except Exception as e:
            print(f"[GoogleNews] skipped query '{q}': {e}", file=sys.stderr)
    return items


def fetch_news_dashboard():
    """General business/startup/employment headlines for the homepage news
    dashboard — same free Google News RSS source as fetch_google_news(),
    but with its own category-specific queries and NO score_signal()
    filtering (that filter looks for personal "I did a side hustle"
    anecdotes, which is too narrow for general news headlines)."""
    from email.utils import parsedate_to_datetime

    items = []
    seen_urls = set()
    seen_titles = {}  # normalized title -> item dict already added to category_items
    for category, queries in NEWS_DASHBOARD_QUERIES.items():
        category_items = []
        norm_index = {}
        for q in queries:
            url = f"https://news.google.com/rss/search?q={requests.utils.quote(q)}&hl=en-IN&gl=IN&ceid=IN:en"
            try:
                r = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
                r.raise_for_status()
                root = ET.fromstring(r.content)
                for item in root.findall(".//item"):
                    title = (item.findtext("title") or "").strip()
                    link = (item.findtext("link") or "").strip()
                    if not title or not link or link in seen_urls:
                        continue
                    desc_raw = (item.findtext("description") or "").strip()
                    desc = re.sub("<[^<]+?>", "", desc_raw).strip()
                    source_el = item.find("source")
                    source_name = source_el.text.strip() if source_el is not None and source_el.text else "Google News"
                    pub_raw = (item.findtext("pubDate") or "").strip()
                    published_at = None
                    if pub_raw:
                        try:
                            published_at = parsedate_to_datetime(pub_raw).isoformat()
                        except Exception:
                            published_at = None
                    seen_urls.add(link)

                    # Dedup: the same event reported by several outlets ends up
                    # as one canonical signal with a source_count, instead of
                    # N near-identical rows in the feed.
                    norm = normalize_title(title)
                    if norm in norm_index:
                        norm_index[norm]["source_count"] += 1
                        continue

                    signal_type = classify_signal(title, desc)
                    row = {
                        "category": category,
                        "title": title,
                        "summary": desc[:280],
                        "url": link,
                        "source": source_name,
                        "published_at": published_at,
                        "signal_type": signal_type,
                        "company": guess_company(title),
                        "source_quality": guess_source_quality(source_name),
                        "source_count": 1,
                    }
                    norm_index[norm] = row
                    category_items.append(row)
            except Exception as e:
                print(f"[NewsDashboard] skipped query '{q}' ({category}): {e}", file=sys.stderr)

        # importance_score: rule-based, favors signals reported by multiple
        # outlets, verified sources, and higher-signal categories (funding /
        # acquisition / layoff tend to matter more than routine market noise).
        HIGH_VALUE_TYPES = {"funding", "acquisition", "layoff", "expansion", "hiring"}
        for row in category_items:
            imp = 30
            imp += min(30, (row["source_count"] - 1) * 15)
            if row["source_quality"] == "verified":
                imp += 20
            if row["signal_type"] in HIGH_VALUE_TYPES:
                imp += 20
            row["importance_score"] = max(0, min(100, imp))

        # newest first, capped per category so the dashboard stays digestible
        category_items.sort(key=lambda x: (x["importance_score"], x["published_at"] or ""), reverse=True)
        dupes_collapsed = sum(r["source_count"] - 1 for r in category_items)
        print(f"[NewsDashboard] {category}: {len(category_items)} unique signals "
              f"({dupes_collapsed} duplicate headlines collapsed) across {len(queries)} queries")
        items.extend(category_items[:NEWS_ITEMS_PER_CATEGORY])
    print(f"[NewsDashboard] total {len(items)} signals fetched across all categories")
    return items


def push_news_to_supabase(items):
    if not (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
        print("[Supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping news push.",
              file=sys.stderr)
        return 0
    if not items:
        return 0

    try:
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/news_items",
            json=items,
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                "Content-Type": "application/json",
                "Prefer": "resolution=ignore-duplicates,return=minimal",
            },
            params={"on_conflict": "url"},
            timeout=30,
        )
    except Exception as e:
        print(f"[Supabase] news insert request failed: {e}", file=sys.stderr)
        return 0
    if not r.ok:
        print(f"[Supabase] news insert failed ({r.status_code}): {r.text[:500]}", file=sys.stderr)
        return 0
    print(f"[Supabase] news insert request ok ({r.status_code}), sent {len(items)} items "
          f"(duplicates by url are silently skipped by Postgres, not reported individually)")
    return len(items)


def prune_old_news(days=14):
    """Keeps the news_items table (and the dashboard) from growing forever
    — deletes anything older than `days` days."""
    if not (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
        return
    cutoff = (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()
    try:
        r = requests.delete(
            f"{SUPABASE_URL}/rest/v1/news_items",
            params={"created_at": f"lt.{cutoff}"},
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            },
            timeout=30,
        )
        if not r.ok:
            print(f"[Supabase] news prune failed ({r.status_code}): {r.text[:300]}", file=sys.stderr)
    except Exception as e:
        print(f"[Supabase] news prune skipped: {e}", file=sys.stderr)



def fetch_youtube():
    if not YOUTUBE_API_KEY:
        print("[YouTube] no YOUTUBE_API_KEY set, skipping", file=sys.stderr)
        return []
    items = []
    try:
        search = requests.get(
            "https://www.googleapis.com/youtube/v3/search",
            params={
                "part": "snippet",
                "q": "side hustle results OR started a business",
                "type": "video",
                "order": "date",
                "maxResults": 10,
                "key": YOUTUBE_API_KEY,
            },
            timeout=15,
        ).json()
        for v in search.get("items", []):
            vid = v.get("id", {}).get("videoId")
            snippet = v.get("snippet", {})
            combined = f"{snippet.get('title', '')}. {snippet.get('description', '')}"
            if not vid or score_signal(combined) == 0:
                continue
            items.append({
                "source": "YouTube",
                "title": snippet.get("title", ""),
                "body": snippet.get("description", "")[:280],
                "engagement": 0,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "work_mode": "local",
                "opportunity_type": "project",
                **extract_details(combined),
            })
    except Exception as e:
        print(f"[YouTube] skipped: {e}", file=sys.stderr)
    return items


def fetch_remotive():
    """https://remotive.com/api/remote-jobs — free, public, no key required."""
    items = []
    try:
        r = requests.get(
            "https://remotive.com/api/remote-jobs",
            params={"limit": 40},
            headers={"User-Agent": USER_AGENT},
            timeout=20,
        )
        r.raise_for_status()
        for job in r.json().get("jobs", [])[:40]:
            title = job.get("title") or ""
            company = job.get("company_name") or ""
            desc = strip_html(job.get("description") or "")[:280]
            job_type = (job.get("job_type") or "").lower()
            opp_type = {
                "full_time": "full_time", "part_time": "part_time",
                "contract": "contract", "freelance": "freelance",
                "internship": "internship",
            }.get(job_type, "contract")
            items.append({
                "source": "Remotive",
                "title": f"{title} at {company}" if company else title,
                "body": desc,
                "engagement": 0,
                "url": job.get("url") or "",
                "location": job.get("candidate_required_location") or None,
                "money_mentioned": job.get("salary") or None,
                "opp_type": job.get("category") or "General",
                "industry_guess": job.get("category") or None,
                "work_mode": "remote",
                "opportunity_type": opp_type,
            })
    except Exception as e:
        print(f"[Remotive] skipped: {e}", file=sys.stderr)
    return items


def fetch_arbeitnow():
    """https://arbeitnow.com/api/job-board-api — free, public, no key required."""
    items = []
    try:
        r = requests.get(
            "https://www.arbeitnow.com/api/job-board-api",
            headers={"User-Agent": USER_AGENT},
            timeout=20,
        )
        r.raise_for_status()
        for job in r.json().get("data", [])[:40]:
            title = job.get("title") or ""
            company = job.get("company_name") or ""
            desc = strip_html(job.get("description") or "")[:280]
            job_types = job.get("job_types") or []
            jt = (job_types[0] if job_types else "").lower().replace(" ", "_")
            opp_type = jt if jt in (
                "full_time", "part_time", "contract", "freelance", "internship",
            ) else "contract"
            items.append({
                "source": "Arbeitnow",
                "title": f"{title} at {company}" if company else title,
                "body": desc,
                "engagement": 0,
                "url": job.get("url") or "",
                "location": job.get("location") or None,
                "money_mentioned": None,
                "opp_type": ", ".join((job.get("tags") or [])[:2]) or "General",
                "industry_guess": (job.get("tags") or [None])[0],
                "work_mode": "remote" if job.get("remote") else "local",
                "opportunity_type": opp_type,
            })
    except Exception as e:
        print(f"[Arbeitnow] skipped: {e}", file=sys.stderr)
    return items


def fetch_remoteok():
    """https://remoteok.com/api — free, public, no key required. First array
    element is RemoteOK's own legal/attribution notice, not a job — skipped."""
    items = []
    try:
        r = requests.get(
            "https://remoteok.com/api",
            headers={"User-Agent": USER_AGENT},
            timeout=20,
        )
        r.raise_for_status()
        jobs = r.json()
        for job in jobs[1:41]:
            if not isinstance(job, dict) or not job.get("id"):
                continue
            title = job.get("position") or job.get("title") or ""
            company = job.get("company") or ""
            desc = strip_html(job.get("description") or "")[:280]
            salary_min = job.get("salary_min")
            salary_max = job.get("salary_max")
            money = f"${salary_min}-${salary_max}" if salary_min and salary_max else None
            items.append({
                "source": "RemoteOK",
                "title": f"{title} at {company}" if company else title,
                "body": desc,
                "engagement": 0,
                "url": job.get("url") or (f"https://remoteok.com/remote-jobs/{job.get('id')}" if job.get("id") else ""),
                "location": job.get("location") or None,
                "money_mentioned": money,
                "pay_min": salary_min,
                "pay_max": salary_max,
                "pay_currency": "USD" if (salary_min or salary_max) else None,
                "opp_type": ", ".join((job.get("tags") or [])[:2]) or "General",
                "industry_guess": (job.get("tags") or [None])[0],
                "work_mode": "remote",
                "opportunity_type": "contract",
            })
    except Exception as e:
        print(f"[RemoteOK] skipped: {e}", file=sys.stderr)
    return items



def fetch_india_jobs():
    """Pulls a wider page of Remotive + RemoteOK listings (same free, public,
    no-key APIs used above) and keeps only the ones explicitly open to
    candidates based in India. Kept as its own source with its own reserved
    slots in main() so India listings don't get crowded out by the generic
    45-item job-board cap."""
    items = []
    india_kw = (
        "india", "bengaluru", "bangalore", "mumbai", "delhi", "new delhi",
        "hyderabad", "pune", "chennai", "kolkata", "gurgaon", "gurugram",
        "noida", "ahmedabad", "jaipur", "chandigarh", "kochi", "indore",
    )

    def is_india(loc):
        loc = (loc or "").lower()
        return any(kw in loc for kw in india_kw)

    try:
        r = requests.get(
            "https://remotive.com/api/remote-jobs",
            params={"limit": 300},
            headers={"User-Agent": USER_AGENT},
            timeout=25,
        )
        r.raise_for_status()
        for job in r.json().get("jobs", []):
            loc = job.get("candidate_required_location") or ""
            if not is_india(loc):
                continue
            title = job.get("title") or ""
            company = job.get("company_name") or ""
            desc = strip_html(job.get("description") or "")[:280]
            job_type = (job.get("job_type") or "").lower()
            opp_type = {
                "full_time": "full_time", "part_time": "part_time",
                "contract": "contract", "freelance": "freelance",
                "internship": "internship",
            }.get(job_type, "contract")
            items.append({
                "source": "Remotive (India)",
                "title": f"{title} at {company}" if company else title,
                "body": desc,
                "engagement": 0,
                "url": job.get("url") or "",
                "location": loc,
                "money_mentioned": job.get("salary") or None,
                "opp_type": job.get("category") or "General",
                "industry_guess": job.get("category") or None,
                "work_mode": "remote",
                "opportunity_type": opp_type,
            })
    except Exception as e:
        print(f"[Remotive-India] skipped: {e}", file=sys.stderr)

    try:
        r = requests.get(
            "https://remoteok.com/api",
            headers={"User-Agent": USER_AGENT},
            timeout=25,
        )
        r.raise_for_status()
        jobs = r.json()
        for job in jobs[1:]:
            if not isinstance(job, dict) or not job.get("id"):
                continue
            loc = job.get("location") or ""
            if not is_india(loc):
                continue
            title = job.get("position") or job.get("title") or ""
            company = job.get("company") or ""
            desc = strip_html(job.get("description") or "")[:280]
            salary_min = job.get("salary_min")
            salary_max = job.get("salary_max")
            money = f"${salary_min}-${salary_max}" if salary_min and salary_max else None
            items.append({
                "source": "RemoteOK (India)",
                "title": f"{title} at {company}" if company else title,
                "body": desc,
                "engagement": 0,
                "url": job.get("url") or (f"https://remoteok.com/remote-jobs/{job.get('id')}" if job.get("id") else ""),
                "location": loc,
                "money_mentioned": money,
                "pay_min": salary_min,
                "pay_max": salary_max,
                "pay_currency": "USD" if (salary_min or salary_max) else None,
                "opp_type": ", ".join((job.get("tags") or [])[:2]) or "General",
                "industry_guess": (job.get("tags") or [None])[0],
                "work_mode": "remote",
                "opportunity_type": "contract",
            })
    except Exception as e:
        print(f"[RemoteOK-India] skipped: {e}", file=sys.stderr)

    return items


VAGUE_LOCATIONS = {
    "worldwide", "remote", "global", "anywhere", "emea", "latam", "apac",
    "americas", "europe", "everywhere", "n/a", "",
}

_GEOCODE_CACHE = {}


def geocode(location_str):
    """Best-effort city/country + lat/lng lookup via Nominatim (OpenStreetMap's
    free, keyless geocoder). Respects their usage policy: max 1 req/sec and a
    descriptive User-Agent (both honored below). Results are cached per run
    so repeated locations (e.g. many "Berlin" listings in one scrape) only
    hit the network once."""
    if not location_str:
        return None
    # skip vague multi-region strings ("Worldwide", "LATAM, Europe, USA...")
    # that Nominatim has no hope of resolving to one point
    first_part = location_str.split(",")[0].strip().lower()
    if first_part in VAGUE_LOCATIONS or location_str.strip().lower() in VAGUE_LOCATIONS:
        return None

    if location_str in _GEOCODE_CACHE:
        return _GEOCODE_CACHE[location_str]

    result = None
    try:
        r = requests.get(
            "https://nominatim.openstreetmap.org/search",
            params={"format": "json", "addressdetails": 1, "limit": 1, "q": location_str},
            headers={"User-Agent": USER_AGENT},
            timeout=15,
        )
        r.raise_for_status()
        hits = r.json()
        if hits:
            hit = hits[0]
            addr = hit.get("address", {})
            city = addr.get("city") or addr.get("town") or addr.get("village") or addr.get("county")
            result = {
                "lat": float(hit["lat"]),
                "lon": float(hit["lon"]),
                "city": city,
                "country": addr.get("country"),
            }
    except Exception as e:
        print(f"[Geocode] skipped '{location_str}': {e}", file=sys.stderr)

    _GEOCODE_CACHE[location_str] = result
    time.sleep(1.1)  # Nominatim usage policy: max 1 request/second
    return result


def fetch_industry_map():
    """Best-effort name->id lookup for the industries table, so job-board
    listings can be tagged with a real industry_id where we can guess one."""
    if not (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
        return {}
    try:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/industries",
            params={"select": "id,name", "status": "eq.approved", "limit": 200},
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            },
            timeout=20,
        )
        r.raise_for_status()
        return {row["name"].lower(): row["id"] for row in r.json()}
    except Exception as e:
        print(f"[Supabase] could not fetch industries, skipping industry tagging: {e}", file=sys.stderr)
        return {}


def match_industry(guess, industry_map):
    if not guess or not industry_map:
        return None
    lower = guess.lower().strip()
    if lower in industry_map:
        return industry_map[lower]
    for name, iid in industry_map.items():
        if name in lower or lower in name:
            return iid
    return None


def fetch_existing_scraped_urls():
    """Pull URLs already stored (source_type='scraped') so we don't re-insert them."""
    if not (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
        return set()
    try:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/opportunities",
            params={"select": "url", "source_type": "eq.scraped", "url": "not.is.null", "limit": 5000},
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            },
            timeout=20,
        )
        r.raise_for_status()
        return {row["url"] for row in r.json() if row.get("url")}
    except Exception as e:
        print(f"[Supabase] could not fetch existing urls, will insert unconditionally: {e}", file=sys.stderr)
        return set()


def push_to_supabase(items, industry_map):
    if not (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
        print("[Supabase] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set — skipping push, "
              "wrote local JSON only. See SETUP_GUIDE.md.", file=sys.stderr)
        return 0

    rows = [{
        "source_type": "scraped",
        "source": it["source"],
        "title": it["title"],
        "body": it["body"],
        "opp_type": it.get("opp_type", "General"),
        "location": it.get("location"),
        "money_mentioned": it.get("money_mentioned"),
        "url": it["url"],
        "engagement": it.get("engagement", 0),
        "posted_by": None,
        "work_mode": it.get("work_mode", "local"),
        "opportunity_type": it.get("opportunity_type", "gig"),
        "pay_min": it.get("pay_min"),
        "pay_max": it.get("pay_max"),
        "pay_currency": it.get("pay_currency"),
        "industry_id": match_industry(it.get("industry_guess"), industry_map),
        "city": it.get("geo_city"),
        "country": it.get("geo_country"),
        "latitude": it.get("latitude"),
        "longitude": it.get("longitude"),
        "score": score_opportunity(it),
    } for it in items]

    if not rows:
        return 0

    r = requests.post(
        f"{SUPABASE_URL}/rest/v1/opportunities",
        json=rows,
        headers={
            "apikey": SUPABASE_SERVICE_ROLE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
        timeout=30,
    )
    if not r.ok:
        print(f"[Supabase] insert failed ({r.status_code}): {r.text[:500]}", file=sys.stderr)
        return 0
    return len(rows)


def fetch_uncoded_opportunities(limit=60):
    """Existing rows (already inserted, from before geocoding existed, or
    from a location Nominatim couldn't previously resolve) that still have
    no map coordinates but do have a location string worth retrying."""
    if not (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
        return []
    try:
        r = requests.get(
            f"{SUPABASE_URL}/rest/v1/opportunities",
            params={
                "select": "id,location",
                "latitude": "is.null",
                "location": "not.is.null",
                "limit": limit,
            },
            headers={
                "apikey": SUPABASE_SERVICE_ROLE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
            },
            timeout=20,
        )
        r.raise_for_status()
        return [row for row in r.json() if row.get("location") and row["location"].strip()]
    except Exception as e:
        print(f"[Backfill] could not fetch uncoded opportunities: {e}", file=sys.stderr)
        return []


def backfill_missing_coordinates(limit=60):
    """One geocode pass over existing rows missing a map pin, so opportunities
    posted/scraped before geocoding existed still show up on the map. Capped
    per run (rate-limited to ~1/sec) and self-heals over a few daily runs."""
    if not (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY):
        return 0
    rows = fetch_uncoded_opportunities(limit)
    updated = 0
    for row in rows:
        loc = geocode(row["location"])
        if not loc:
            continue
        try:
            r = requests.patch(
                f"{SUPABASE_URL}/rest/v1/opportunities",
                params={"id": f"eq.{row['id']}"},
                json={
                    "latitude": loc["lat"],
                    "longitude": loc["lon"],
                    "city": loc["city"],
                    "country": loc["country"],
                },
                headers={
                    "apikey": SUPABASE_SERVICE_ROLE_KEY,
                    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
                    "Content-Type": "application/json",
                    "Prefer": "return=minimal",
                },
                timeout=20,
            )
            if r.ok:
                updated += 1
        except Exception as e:
            print(f"[Backfill] could not update {row['id']}: {e}", file=sys.stderr)
    print(f"[Backfill] geocoded {updated}/{len(rows)} existing opportunities that were missing coordinates")
    return updated


def main():
    all_items = []
    all_items += fetch_hn()
    all_items += fetch_google_news()
    all_items += fetch_youtube()
    all_items.sort(key=lambda x: x["engagement"], reverse=True)
    signal_top = all_items[:15]

    job_board_items = []
    job_board_items += fetch_remotive()
    job_board_items += fetch_arbeitnow()
    job_board_items += fetch_remoteok()
    # job-board listings ARE the opportunity, not text to signal-score, so
    # they're capped separately rather than competing with HN/News engagement
    job_board_top = job_board_items[:45]

    # India-based listings get their own reserved slots so they can't get
    # crowded out by the generic 45-item job-board cap above.
    india_items = fetch_india_jobs()
    india_top = india_items[:25]

    combined = signal_top + job_board_top + india_top

    seen = set()
    deduped = []
    for it in combined:
        if not it["url"] or it["url"] in seen:
            continue
        seen.add(it["url"])
        deduped.append(it)

    top = deduped

    # local debug copy — the live site reads from Supabase, not this file
    os.makedirs(os.path.dirname(DEBUG_OUT_PATH), exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(top),
        "opportunities": top,
    }
    with open(DEBUG_OUT_PATH, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"Wrote {len(top)} opportunities to local debug file {DEBUG_OUT_PATH}")

    industry_map = fetch_industry_map()
    existing_urls = fetch_existing_scraped_urls()
    new_items = [it for it in top if it["url"] not in existing_urls]

    # Geocode only the genuinely new items (not the full 60+ every run) —
    # this is what puts pins on the homepage map. Nominatim's free API is
    # rate-limited to 1 req/sec, so this adds roughly 1 second per unique
    # location, which is well within a GitHub Actions job's time budget.
    geocoded = 0
    for it in new_items:
        loc = geocode(it.get("location"))
        if loc:
            it["latitude"] = loc["lat"]
            it["longitude"] = loc["lon"]
            it["geo_city"] = loc["city"]
            it["geo_country"] = loc["country"]
            geocoded += 1
    print(f"[Geocode] resolved {geocoded}/{len(new_items)} new items to map coordinates")

    inserted = push_to_supabase(new_items, industry_map)
    print(f"Inserted {inserted} new opportunities into Supabase "
          f"({len(top) - len(new_items)} already present, skipped)")

    backfill_missing_coordinates(limit=60)

    # Daily news dashboard (separate table, independent of the opportunity
    # feed above) — general business/startup/employment headlines.
    news_items = fetch_news_dashboard()
    news_inserted = push_news_to_supabase(news_items)
    print(f"Inserted {news_inserted} news items (duplicates by url skipped)")
    prune_old_news(days=14)


if __name__ == "__main__":
    main()
