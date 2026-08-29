#!/usr/bin/env python3
"""
Daily Opportunity Scraper

Pulls real, currently-being-discussed side-hustle / business-opportunity
signals from sources that are free to use AND legal to build a paid product
on top of:

  - Hacker News (Algolia API)   -> no key needed, no commercial restriction
  - Google News RSS (keyword)   -> public syndication feed, no key needed
  - YouTube Data API            -> free quota, needs YOUTUBE_API_KEY (optional;
                                     script still runs without it, just skips)

Reddit and X/Twitter are deliberately NOT included: neither has a free tier
that a paid subscription product is allowed to run on. LinkedIn, Indeed,
Craigslist and Upwork are also deliberately NOT scraped: LinkedIn and Indeed's
terms of service explicitly prohibit scraping (LinkedIn has won litigation
over exactly this), Upwork has no public opportunities API, and Craigslist
blocks automated access. Only sources that are both free and ToS-compliant
are used here.

Where results go:
  - Inserted directly into the Supabase "opportunities" table (source_type
    = 'scraped'), using the SERVICE ROLE key so they show up in the live
    feed at docs/index.html alongside user-submitted postings.
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
import xml.etree.ElementTree as ET
from datetime import datetime, timezone

import requests

YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "")
SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")

DEBUG_OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "opportunities.json")

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
                    **extract_details(combined),
                })
        except Exception as e:
            print(f"[GoogleNews] skipped query '{q}': {e}", file=sys.stderr)
    return items


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
                **extract_details(combined),
            })
    except Exception as e:
        print(f"[YouTube] skipped: {e}", file=sys.stderr)
    return items


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


def push_to_supabase(items):
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


def main():
    all_items = []
    all_items += fetch_hn()
    all_items += fetch_google_news()
    all_items += fetch_youtube()

    seen = set()
    deduped = []
    for it in all_items:
        if not it["url"] or it["url"] in seen:
            continue
        seen.add(it["url"])
        deduped.append(it)

    deduped.sort(key=lambda x: x["engagement"], reverse=True)
    top = deduped[:15]

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

    existing_urls = fetch_existing_scraped_urls()
    new_items = [it for it in top if it["url"] not in existing_urls]
    inserted = push_to_supabase(new_items)
    print(f"Inserted {inserted} new opportunities into Supabase "
          f"({len(top) - len(new_items)} already present, skipped)")


if __name__ == "__main__":
    main()
