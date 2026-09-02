// Seeker — shared Supabase client, auth helpers, and nav renderer.
// Loaded on every page after config.js and the supabase-js CDN script.

(function () {
  const cfg = window.OPPORTUNITY_HUB_CONFIG || {};
  const configured =
    cfg.SUPABASE_URL &&
    cfg.SUPABASE_ANON_KEY &&
    !cfg.SUPABASE_URL.includes("PASTE_YOUR") &&
    !cfg.SUPABASE_ANON_KEY.includes("PASTE_YOUR");

  window.OH_CONFIGURED = configured;

  window.sb = configured
    ? supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY)
    : null;

  // ---------- small shared utilities ----------
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }
  window.escapeHtml = escapeHtml;

  function starString(avg) {
    const rounded = Math.round(avg || 0);
    let out = "";
    for (let i = 0; i < 5; i++) {
      out += i < rounded ? "★" : '<span class="off">★</span>';
    }
    return out;
  }
  window.starString = starString;

  function timeAgo(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const diffMs = Date.now() - d.getTime();
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return mins + "m ago";
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    const days = Math.floor(hrs / 24);
    if (days < 30) return days + "d ago";
    return d.toLocaleDateString();
  }
  window.timeAgo = timeAgo;

  // Normalizes a scraped/free-text company name into a stable key for
  // grouping and URL-matching (there is no company entity table — company
  // pages match by name, case/whitespace-insensitively, and say so).
  function companySlug(name) {
    return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
  }
  window.OH_companySlug = companySlug;

  function companyLinkHtml(name) {
    if (!name) return "";
    return `<a class="company-link" href="company.html?name=${encodeURIComponent(name)}">${escapeHtml(name)} →</a>`;
  }
  window.OH_companyLinkHtml = companyLinkHtml;

  function showConfigWarning() {
    if (configured) return;
    const el = document.createElement("div");
    el.style.cssText =
      "border:2px solid #f16565;color:#f16565;background:rgba(241,101,101,0.08);" +
      "padding:0.8rem 1rem;margin:0.6rem;font-size:0.78rem;text-align:center;position:relative;z-index:10;border-radius:10px;";
    el.innerHTML =
      "SUPABASE NOT CONFIGURED — edit <code>docs/js/config.js</code> with your project URL + anon key. " +
      'See <a href="SETUP_GUIDE.md" style="color:#f16565;text-decoration:underline;">SETUP_GUIDE.md</a>.';
    document.body.insertBefore(el, document.body.firstChild);
  }

  // ---------- auth ----------
  const Auth = {
    async getUser() {
      if (!window.sb) return null;
      const { data } = await window.sb.auth.getUser();
      return data ? data.user : null;
    },
    async getProfile(userId) {
      if (!window.sb || !userId) return null;
      const { data } = await window.sb
        .from("profiles")
        .select("*")
        .eq("id", userId)
        .maybeSingle();
      return data;
    },
    async getActiveSubscription(userId) {
      if (!window.sb || !userId) return null;
      const { data } = await window.sb
        .from("subscriptions")
        .select("status, current_period_end")
        .eq("user_id", userId)
        .eq("status", "active")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    },
    async signUp(email, password, username) {
      const { data, error } = await window.sb.auth.signUp({
        email,
        password,
        options: { data: { username } },
      });
      if (error) throw error;
      return data;
    },
    async signIn(email, password) {
      const { data, error } = await window.sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data;
    },
    async signOut() {
      await window.sb.auth.signOut();
    },
    requireLogin(redirectTarget) {
      const target = redirectTarget || window.location.pathname.split("/").pop();
      window.location.href = "auth.html?redirect=" + encodeURIComponent(target);
    },
    async getSavedIds(userId) {
      if (!window.sb || !userId) return new Set();
      const { data } = await window.sb
        .from("saved_opportunities")
        .select("opportunity_id")
        .eq("profile_id", userId);
      return new Set((data || []).map((r) => r.opportunity_id));
    },
    async saveOpportunity(userId, opportunityId) {
      if (!window.sb || !userId) return;
      const { error } = await window.sb
        .from("saved_opportunities")
        .insert({ profile_id: userId, opportunity_id: opportunityId });
      if (error && !String(error.message || "").includes("duplicate")) throw error;
      window.OH_logEvent(userId, opportunityId, "save");
    },
    async unsaveOpportunity(userId, opportunityId) {
      if (!window.sb || !userId) return;
      const { error } = await window.sb
        .from("saved_opportunities")
        .delete()
        .eq("profile_id", userId)
        .eq("opportunity_id", opportunityId);
      if (error) throw error;
      window.OH_logEvent(userId, opportunityId, "unsave");
    },
    // ---------- Phase 3: saved searches + preferences ----------
    async getSavedSearches(userId) {
      if (!window.sb || !userId) return [];
      const { data, error } = await window.sb
        .from("saved_searches")
        .select("*")
        .eq("profile_id", userId)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data || [];
    },
    async saveSearch(userId, name, query) {
      if (!window.sb || !userId) return;
      const { error } = await window.sb
        .from("saved_searches")
        .insert({ profile_id: userId, name: name.slice(0, 80), query });
      if (error) throw error;
    },
    async deleteSavedSearch(userId, id) {
      if (!window.sb || !userId) return;
      const { error } = await window.sb
        .from("saved_searches")
        .delete()
        .eq("id", id)
        .eq("profile_id", userId);
      if (error) throw error;
    },
    async touchSavedSearch(userId, id) {
      if (!window.sb || !userId) return;
      await window.sb
        .from("saved_searches")
        .update({ last_viewed_at: new Date().toISOString() })
        .eq("id", id)
        .eq("profile_id", userId);
    },
    async updatePreferences(userId, prefs) {
      if (!window.sb || !userId) return;
      const { error } = await window.sb
        .from("profiles")
        .update({ preferences: prefs })
        .eq("id", userId);
      if (error) throw error;
    },
    // ---------- Foundation phase: User Opportunity DNA / onboarding ----------
    async saveDna(userId, { dna, intents }) {
      if (!window.sb || !userId) return;
      const { error } = await window.sb
        .from("profiles")
        .update({ dna, intents, onboarding_completed: true, onboarding_skipped: false })
        .eq("id", userId);
      if (error) throw error;
    },
    async skipOnboarding(userId) {
      if (!window.sb || !userId) return;
      await window.sb
        .from("profiles")
        .update({ onboarding_skipped: true })
        .eq("id", userId);
    },
  };
  window.Auth = Auth;

  // ================================================================
  // 10/10 UI direction — shared "operating system" intelligence layer.
  // Lives here (not opportunities-feed.js) because every page needs it:
  // the homepage cards, the detail page, and the leads page all show
  // Match/Quality/Confidence + trust state + why-this-matches text.
  // ================================================================

  function dnaTokenize(str) {
    if (!str) return [];
    return String(str).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2);
  }
  window.OH_dnaTokenize = dnaTokenize;

  const WORK_MODE_LABELS_SHARED = { remote: "Remote", hybrid: "Hybrid", local: "Local", relocation: "Relocation", travel: "Travel" };

  // MATCH — lightweight, explainable heuristic (keyword overlap + a few
  // exact-match bonuses), blended with the opportunity's own quality score.
  // Deliberately not a trained model: "no big recommendation engine before
  // data" was the rule from day one, and it still holds.
  function computeDnaScore(opp, dna) {
    if (!dna || !Object.keys(dna).length) return 0;
    const profileWords = [];
    const locations = [];
    let workMode = null;
    let govLevel = null;
    Object.values(dna).forEach((fields) => {
      if (!fields || typeof fields !== "object") return;
      Object.keys(fields).forEach((fk) => {
        const v = fields[fk];
        if (typeof v !== "string" || !v) return;
        if (fk === "work_mode") { workMode = v; return; }
        if (fk === "government_level") { govLevel = v; return; }
        if (["location", "state", "city", "region"].includes(fk)) { locations.push(v.toLowerCase()); return; }
        profileWords.push(...dnaTokenize(v));
      });
    });

    const oppText = [
      opp.title, opp.body, opp.industries && opp.industries.name, opp.department,
      Array.isArray(opp.skills) ? opp.skills.join(" ") : "",
    ].filter(Boolean).join(" ");
    const oppWords = new Set(dnaTokenize(oppText));
    let overlap = 0;
    profileWords.forEach((w) => { if (oppWords.has(w)) overlap++; });
    const overlapRatio = profileWords.length ? overlap / profileWords.length : 0;
    let keywordScore = Math.min(60, overlapRatio * 200);

    let bonus = 0;
    const oppLoc = (opp.city || opp.location || "").toLowerCase();
    if (oppLoc && locations.some((l) => oppLoc.includes(l) || l.includes(oppLoc))) bonus += 15;
    if (workMode && opp.work_mode && workMode === opp.work_mode) bonus += 10;
    if (govLevel && opp.government_level && govLevel === opp.government_level) bonus += 15;

    const qualityBlend = (opp.score || 0) * 0.15;
    return Math.round(Math.min(100, keywordScore + bonus + qualityBlend));
  }
  window.OH_computeDnaScore = computeDnaScore;

  // Short, human-readable reason a card matched.
  function explainDnaMatch(opp, dna) {
    if (!dna || !Object.keys(dna).length) return null;
    const words = [];
    let workMode = null, govLevel = null;
    Object.values(dna).forEach((fields) => {
      if (!fields || typeof fields !== "object") return;
      Object.keys(fields).forEach((fk) => {
        const v = fields[fk];
        if (typeof v !== "string" || !v) return;
        if (fk === "work_mode") { workMode = v; return; }
        if (fk === "government_level") { govLevel = v; return; }
        words.push(...dnaTokenize(v));
      });
    });
    const oppText = [opp.title, opp.body, opp.industries && opp.industries.name, opp.department].filter(Boolean).join(" ");
    const oppWords = new Set(dnaTokenize(oppText));
    const matched = [...new Set(words)].filter((w) => oppWords.has(w)).slice(0, 4);
    return matched.length || (workMode && opp.work_mode === workMode) || (govLevel && opp.government_level === govLevel)
      ? { matched, workMode: workMode && opp.work_mode === workMode ? workMode : null, govMatch: !!(govLevel && opp.government_level === govLevel) }
      : null;
  }
  window.OH_explainDnaMatch = explainDnaMatch;

  // Renders the explain result above as a <ul class="why-list"> HTML string
  // ("WHY THIS MATCHES" per spec section 06) — used on the homepage's best
  // -opportunity cards and the detail page.
  function whyListHtml(opp, dna) {
    const why = explainDnaMatch(opp, dna);
    if (!why) return "";
    const items = [];
    if (why.matched.length) items.push(`Mentions ${escapeHtml(why.matched.join(", "))}`);
    if (why.workMode) items.push(`${escapeHtml(WORK_MODE_LABELS_SHARED[why.workMode] || why.workMode)} — matches your preference`);
    if (why.govMatch) items.push("Matches your preferred government level");
    if (!items.length) return "";
    return `<ul class="why-list">${items.map((t) => `<li>${t}</li>`).join("")}</ul>`;
  }
  window.OH_whyListHtml = whyListHtml;

  // QUALITY — bucketed from the existing rule-based opportunity score
  // (freshness + completeness + credibility). Separate from Match on
  // purpose: a listing can be a 99% match and still be a low-quality one.
  function qualityBucket(opp) {
    const s = opp.score || 0;
    if (s >= 70) return { label: "HIGH", cls: "quality-high", value: s };
    if (s >= 40) return { label: "MID", cls: "quality-mid", value: s };
    return { label: "LOW", cls: "quality-low", value: s };
  }
  window.OH_qualityBucket = qualityBucket;

  // CONFIDENCE — how complete/fresh/well-sourced the listing's data itself
  // is, independent of quality or match. A new, honest metric: how sure are
  // we that what this card says is accurate, not how good the opportunity is.
  function computeConfidence(opp) {
    let points = 0, max = 0;
    const has = (v) => v !== null && v !== undefined && v !== "";
    [opp.body && opp.body.length > 60, opp.pay_min || opp.money_mentioned, opp.city || opp.location,
      opp.url, opp.industries && opp.industries.name].forEach((v) => { max += 20; if (v) points += 20; });
    const ref = opp.last_verified_at || opp.created_at;
    let recencyBonus = 0;
    if (ref) {
      const days = (Date.now() - new Date(ref).getTime()) / 86400000;
      recencyBonus = days < 3 ? 10 : days < 14 ? 5 : 0;
    }
    return Math.max(0, Math.min(100, Math.round(points * 0.8 / Math.max(max, 1) * 100 * 0.8 + recencyBonus + (opp.status === "speculative" ? -15 : 0))));
  }
  window.OH_computeConfidence = computeConfidence;

  // TRUST STATE — derived from what we actually know about the source,
  // never invented. Government-linked scraped listings read as the most
  // trustworthy by design (spec section 17: government gets trust-first UX).
  function trustState(opp) {
    if (opp.status === "speculative") return { key: "detected", label: "Detected", hint: "AI/system inference from a news signal — not a confirmed posting." };
    if (opp.source_type === "user") return { key: "unverified", label: "Unverified", hint: "Self-submitted — not yet confirmed by Seeker." };
    if (opp.government_level) return { key: "verified", label: "Verified", hint: "Official source, scraped directly." };
    return { key: "confirmed", label: "Confirmed", hint: "From a live listing on a real source." };
  }
  window.OH_trustState = trustState;

  function trustBadgeHtml(opp) {
    const t = trustState(opp);
    return `<span class="trust-badge ${t.key}" title="${escapeHtml(t.hint)}">${t.label}</span>`;
  }
  window.OH_trustBadgeHtml = trustBadgeHtml;

  // FACT / SIGNAL / INFERENCE / PREDICTION — a signal is always a fact;
  // everything downstream of it is explicitly labeled as interpretation,
  // not presented as more news. Templates are intentionally plain and
  // conservative rather than generated, so Seeker never states an
  // inference as if it were verified.
  const SIGNAL_TEMPLATES = {
    funding: { inference: "may increase hiring, expansion, and demand for vendors", prediction: "Hiring and vendor activity are likely to rise in the coming weeks." },
    hiring: { inference: "signals active team growth right now", prediction: "More openings from this company are likely in the near term." },
    layoff: { inference: "may reduce this company's hiring and vendor spend", prediction: "New postings from this company are less likely for now." },
    expansion: { inference: "may increase demand for local hires and vendors", prediction: "New roles or contracts in the expansion market are likely." },
    launch: { inference: "may increase marketing, support, and vendor needs", prediction: "Related hiring or contract activity is likely to follow." },
    acquisition: { inference: "often leads to org changes and new hiring plans", prediction: "New roles or restructuring are possible in the coming months." },
    regulation: { inference: "may create compliance-related work", prediction: "Demand for compliance and legal support may increase." },
    government: { inference: "may open new public-sector opportunities", prediction: "Related notifications or tenders are likely to follow." },
    market: { inference: "reflects a shift worth watching in this sector", prediction: "Related opportunities may follow as the market adjusts." },
    business: { inference: "reflects this company's current momentum", prediction: "Related opportunities may follow." },
    technology: { inference: "signals a shift in tooling or technical needs", prediction: "Related technical roles or projects may follow." },
    other: { inference: "may be relevant to opportunities in this space", prediction: "Worth watching for related activity." },
  };
  function evidenceChain(signal) {
    if (!signal) return null;
    const t = SIGNAL_TEMPLATES[signal.signal_type] || SIGNAL_TEMPLATES.other;
    return {
      fact: signal.title,
      inference: (signal.company ? escapeHtml(signal.company) : "This") + " " + t.inference + ".",
      prediction: t.prediction,
    };
  }
  window.OH_evidenceChain = evidenceChain;

  function evidenceChainHtml(signal) {
    const chain = evidenceChain(signal);
    if (!chain) return "";
    return `
      <div class="evidence-chain">
        <div class="evidence-row"><span class="evidence-tag fact">Fact</span><span class="evidence-text">${escapeHtml(chain.fact)}</span></div>
        <div class="evidence-row"><span class="evidence-tag inference">Inference</span><span class="evidence-text">${chain.inference}</span></div>
        <div class="evidence-row"><span class="evidence-tag prediction">Prediction</span><span class="evidence-text">${escapeHtml(chain.prediction)}</span></div>
      </div>`;
  }
  window.OH_evidenceChainHtml = evidenceChainHtml;

  // ---------- opportunity lifecycle ----------
  // A real, honest state derived only from timestamps/status already on the
  // row — never a fabricated "trending" or "hot" label with no signal
  // behind it. Mirrors the Deadline-window logic used on the homepage.
  const LIFECYCLE_CLOSING_WINDOW_DAYS = 5;
  function lifecycleState(opp) {
    if (opp.status && opp.status !== "active" && opp.status !== "speculative") {
      return { key: "expired", label: "Expired", cls: "lifecycle-expired" };
    }
    const now = Date.now();
    if (opp.end_date) {
      const daysLeft = Math.ceil((new Date(opp.end_date).getTime() - now) / 86400000);
      if (daysLeft < 0) return { key: "expired", label: "Expired", cls: "lifecycle-expired" };
      if (daysLeft <= LIFECYCLE_CLOSING_WINDOW_DAYS) return { key: "closing", label: "Closing Soon", cls: "lifecycle-closing" };
    }
    if (opp.created_at) {
      const days = (now - new Date(opp.created_at).getTime()) / 86400000;
      if (days < 1) return { key: "discovered", label: "Just Discovered", cls: "lifecycle-discovered" };
      if (days < 3) return { key: "new", label: "New", cls: "lifecycle-new" };
    }
    return { key: "active", label: "Active", cls: "lifecycle-active" };
  }
  window.OH_lifecycleState = lifecycleState;

  function lifecycleBadgeHtml(opp) {
    const s = lifecycleState(opp);
    return `<span class="lifecycle-badge ${s.cls}">${s.label}</span>`;
  }
  window.OH_lifecycleBadgeHtml = lifecycleBadgeHtml;

  // ---------- lightweight outcome event logging ----------
  // First honest step toward "the product should learn from outcomes"
  // (spec section 20): capture what happens, don't fake a re-ranking model
  // on top of a few days of data. Never throws — logging must never break
  // the action the user was actually trying to take.
  async function logEvent(userId, opportunityId, eventType) {
    if (!window.sb || !userId || !opportunityId) return;
    try {
      await window.sb.from("events").insert({ profile_id: userId, opportunity_id: opportunityId, event_type: eventType });
    } catch (err) { /* best-effort only */ }
  }
  window.OH_logEvent = logEvent;

  // ---------- outcome-based ranking boost (real, not simulated) ----------
  // Builds a small profile of what this specific user has actually saved
  // or clicked apply on, from the events table, and uses it to nudge Match
  // toward more of the same. This is deliberately a transparent weighted-
  // overlap boost, not a trained model — there isn't remotely enough data
  // for one yet, and a fake model would be worse than an honest heuristic.
  // With no event history it changes nothing (baseline DNA match stands).
  async function getEventBoostProfile(userId) {
    if (!window.sb || !userId) return null;
    try {
      const { data, error } = await window.sb
        .from("events")
        .select("event_type, opportunities:opportunity_id ( industry_id, opportunity_type, work_mode, company )")
        .eq("profile_id", userId)
        .in("event_type", ["save", "apply_click", "contact_click"])
        .limit(300);
      if (error || !data || !data.length) return null;

      const industries = new Map();
      const types = new Map();
      const modes = new Map();
      const companies = new Map();
      const weightFor = (t) => (t === "save" ? 1 : 2); // an actual apply/contact click counts for more than a save

      data.forEach((row) => {
        const opp = row.opportunities;
        if (!opp) return;
        const w = weightFor(row.event_type);
        if (opp.industry_id) industries.set(opp.industry_id, (industries.get(opp.industry_id) || 0) + w);
        if (opp.opportunity_type) types.set(opp.opportunity_type, (types.get(opp.opportunity_type) || 0) + w);
        if (opp.work_mode) modes.set(opp.work_mode, (modes.get(opp.work_mode) || 0) + w);
        if (opp.company) {
          const key = companySlug(opp.company);
          companies.set(key, (companies.get(key) || 0) + w);
        }
      });

      if (!industries.size && !types.size && !modes.size && !companies.size) return null;
      return { industries, types, modes, companies, eventCount: data.length };
    } catch (err) {
      return null;
    }
  }
  window.OH_getEventBoostProfile = getEventBoostProfile;

  // Applies the boost profile above to a base Match score. Capped so a
  // history signal alone can't manufacture a 100% match on an otherwise
  // unrelated listing.
  function applyEventBoost(baseMatch, opp, boostProfile) {
    if (!boostProfile) return baseMatch;
    let boost = 0;
    if (opp.industry_id && boostProfile.industries.has(opp.industry_id)) boost += 8;
    if (opp.opportunity_type && boostProfile.types.has(opp.opportunity_type)) boost += 6;
    if (opp.work_mode && boostProfile.modes.has(opp.work_mode)) boost += 4;
    if (opp.company && boostProfile.companies.has(companySlug(opp.company))) boost += 12;
    return Math.max(0, Math.min(100, Math.round(baseMatch + Math.min(20, boost))));
  }
  window.OH_applyEventBoost = applyEventBoost;

  // ---------- shared nav ----------
  async function renderNav(activeId) {
    const mount = document.getElementById("site-nav");
    if (!mount) return;

    const links = [
      { id: "feed", href: "index.html", label: "Home" },
      { id: "opportunities", href: "opportunities.html", label: "Opportunities" },
      { id: "leads", href: "leads.html", label: "Leads" },
      { id: "signals", href: "signals.html", label: "Signals" },
      { id: "radar", href: "radar.html", label: "Radar" },
      { id: "messages", href: "messages.html", label: "Messages" },
    ];

    mount.innerHTML =
      '<div class="nav">' +
      links
        .map(
          (l) =>
            `<a href="${l.href}" class="${l.id === activeId ? "active" : ""}">${l.label}</a>`
        )
        .join("") +
      `<a href="post.html" class="post-cta ${activeId === "post" ? "active" : ""}">+ Post</a>` +
      '</div><div class="auth-widget" id="auth-widget">checking session...</div>';

    const widget = document.getElementById("auth-widget");
    if (!configured) {
      widget.innerHTML = '<span class="who">not connected to Supabase yet</span>';
      return;
    }

    const user = await Auth.getUser();
    if (!user) {
      widget.innerHTML =
        '<a class="link-btn" href="auth.html">Log In / Sign Up</a>';
      return;
    }

    const profile = await Auth.getProfile(user.id);
    const uname = profile ? profile.username : user.email;
    const activeSub = await Auth.getActiveSubscription(user.id);
    const subBadge = activeSub
      ? '<span class="sub-badge sub-active">SUBSCRIBER</span>'
      : '<span class="sub-badge sub-inactive">FREE</span>';
    widget.innerHTML =
      `<span class="who">signed in as <a href="profile.html?id=${user.id}">${escapeHtml(uname)}</a></span>` +
      subBadge +
      '<button id="logout-btn">Log Out</button>';
    document.getElementById("logout-btn").addEventListener("click", async () => {
      await Auth.signOut();
      window.location.reload();
    });
  }
  window.renderNav = renderNav;

  document.addEventListener("DOMContentLoaded", showConfigWarning);
})();
