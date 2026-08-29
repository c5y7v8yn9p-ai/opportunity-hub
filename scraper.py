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

Reddit and X/Twitter are deliberately NOT included: as of 2026 neither one
has a free tier that a paid subscription product is allowed to run on
(X retired its free/flat plans for pay-per-use; Reddit's free tier explicitly
bans commercial use and would need a paid license). Add them back later once
there's revenue to license them properly.

Output: docs/opportunities.json  (the site in docs/index.html reads this file)
"""
import os
import re
import sys
import json
from datetime import datetime, timezone

import xml.etree.ElementTree as ET
import requests

YOUTUBE_API_KEY = os.environ.get("YOUTUBE_API_KEY", "")
OUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "docs", "opportunities.json")

SIGNAL_WORDS = [
    "opportunity", "started", "made", "earning", "profit", "side hustle",
    "import", "export", "business idea", "launched", "bootstrapped",
    "side income", "passive income", "selling", "reseller",
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
    details = {"location": None, "money_mentioned": None, "type": "General"}
    for loc in LOCATIONS:
        if loc.lower() in text.lower():
            details["location"] = loc
            break
    money = re.findall(r"(?:₹|Rs\.?|\$)\s?[\d,]+(?:\.\d+)?", text)
    if money:
        details["money_mentioned"] = money[0]
    lower = text.lower()
    if "import" in lower or "export" in lower:
        details["type"] = "Trading / Import-Export"
    elif "app" in lower or "software" in lower or "saas" in lower:
        details["type"] = "Tech / Software"
    elif "sell" in lower or "reseller" in lower or "ecommerce" in lower or "e-commerce" in lower:
        details["type"] = "E-commerce / Reselling"
    elif "service" in lower or "freelance" in lower or "consult" in lower:
        details["type"] = "Service / Freelance"
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
                    "text": (text or title)[:280],
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
                    "text": desc[:280],
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
                "text": snippet.get("description", "")[:280],
                "engagement": 0,
                "url": f"https://www.youtube.com/watch?v={vid}",
                **extract_details(combined),
            })
    except Exception as e:
        print(f"[YouTube] skipped: {e}", file=sys.stderr)
    return items


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

    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(top),
        "opportunities": top,
    }
    with open(OUT_PATH, "w") as f:
        json.dump(payload, f, indent=2)

    print(f"Wrote {len(top)} opportunities to {OUT_PATH}")


if __name__ == "__main__":
    main()
