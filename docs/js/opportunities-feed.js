// Seeker — shared Opportunities+Map feed. Used by both index.html
// (FEED — homepage) and opportunities.html (OPPORTUNITIES — the dedicated
// full database page). Both pages include this file after supabase-client.js
// and Leaflet + Leaflet.markercluster, and provide the same container IDs:
//   #search-input #industry-chips #type-chips #workmode-chips
//   #experience-chips #gov-chips #sort-select #results-count #opportunities
//   #leaflet-map #report-modal (+ its fields) #map-filter-note
//   #save-search-name #save-search-btn #save-search-msg (optional — only
//   present on pages with the full filter bar, i.e. opportunities.html)
//
// Call initOpportunitiesFeed() once the DOM is ready.

const OPPORTUNITY_TYPE_LABELS = {
  full_time: "Full-time", part_time: "Part-time", contract: "Contract",
  freelance: "Freelance", gig: "Gig", one_time_task: "One-off task",
  project: "Project", seasonal: "Seasonal", internship: "Internship",
  apprenticeship: "Apprenticeship", volunteer: "Volunteer", service_request: "Service request",
};
const EXPERIENCE_LABELS = {
  no_experience: "No experience", beginner: "Entry", intermediate: "Mid",
  advanced: "Senior", any: "Any level",
};
const WORK_MODE_LABELS = { remote: "Remote", hybrid: "Hybrid", local: "Local", relocation: "Relocation", travel: "Travel" };
const CATEGORY_GROUPS = {
  jobs: ["full_time", "part_time", "contract", "internship", "apprenticeship", "seasonal", "volunteer"],
  projects: ["project", "freelance", "gig", "one_time_task", "service_request"],
};
const GOV_LEVEL_LABELS = {
  central: "Central Govt", state: "State Govt", psu: "PSU", railways: "Railways", banking: "Banking",
  defence: "Defence", police: "Police", teaching: "Teaching", healthcare: "Healthcare",
  administrative: "Administrative", other: "Other Govt",
};

// Words the search box recognizes as filters rather than free text — this
// is the "search itself is the AI interface" from the spec: no chatbot,
// just a decent keyword parser. Anything left over after removing these
// becomes a plain substring match against title/body/skills.
const SEARCH_WORKMODE_WORDS = { remote: "remote", hybrid: "hybrid", local: "local", "on-site": "local", onsite: "local" };
const SEARCH_TYPE_WORDS = {
  freelance: "freelance", freelancing: "freelance", contract: "contract",
  gig: "gig", internship: "internship", intern: "internship",
  "part-time": "part_time", parttime: "part_time", "full-time": "full_time",
  fulltime: "full_time", volunteer: "volunteer", seasonal: "seasonal",
  project: "project", tender: "service_request",
};
const SEARCH_STOPWORDS = new Set(["jobs", "job", "opportunities", "opportunity", "for", "in", "under", "a", "an", "the", "work", "hours", "week", "hour"]);

function parseSearchQuery(raw) {
  const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
  let workMode = null, oppType = null;
  const rest = [];
  for (const w of words) {
    if (!workMode && SEARCH_WORKMODE_WORDS[w]) { workMode = SEARCH_WORKMODE_WORDS[w]; continue; }
    if (!oppType && SEARCH_TYPE_WORDS[w]) { oppType = SEARCH_TYPE_WORDS[w]; continue; }
    if (SEARCH_STOPWORDS.has(w)) continue;
    rest.push(w);
  }
  return { workMode, oppType, freeText: rest.join(" ").trim() };
}

(function () {
  let map, markerLayer, clusterGroup;
  let allOpps = [];
  let activeIndustry = null;
  let activeType = "";
  let activeWorkMode = "";
  let activeExperience = "";
  let activeGovLevel = "";
  let activeCategory = "";
  let searchTerm = "";
  let sortMode = "recommended";
  let myCapabilities = [];
  let mySavedIds = new Set();
  let currentUser = null;
  let myPreferences = null;
  let myDna = null;
  let myBoostProfile = null;
  let mapFilterIds = null; // Set of ids, or null = no map-cluster filter active
  let mapFilterLabel = "";
  let showSpeculative = false;

  function oppLabel(opp) { return opp.title || (opp.body || "").slice(0, 60) || "Untitled opportunity"; }

  function metaTags(opp) {
    const tags = [];
    if (opp.industries && opp.industries.name) tags.push(opp.industries.name);
    else if (opp.opp_type) tags.push(opp.opp_type);
    if (opp.opportunity_type && OPPORTUNITY_TYPE_LABELS[opp.opportunity_type]) tags.push(OPPORTUNITY_TYPE_LABELS[opp.opportunity_type]);
    if (opp.work_mode) tags.push(WORK_MODE_LABELS[opp.work_mode] || opp.work_mode);
    if (opp.city || opp.location) tags.push(opp.city || opp.location);
    if (opp.pay_min) {
      const cur = opp.pay_currency || "INR";
      tags.push(opp.pay_max && opp.pay_max !== opp.pay_min ? `${cur} ${opp.pay_min}-${opp.pay_max}` : `${cur} ${opp.pay_min}+`);
    } else if (opp.money_mentioned) {
      tags.push(opp.money_mentioned);
    }
    return tags.map((t) => (t.length > 36 ? t.slice(0, 33) + "…" : t));
  }

  function freshness(opp) {
    if (opp.expires_at && new Date(opp.expires_at) < new Date()) return { label: "Expired", cls: "bad" };
    const ref = opp.last_verified_at || opp.created_at;
    if (!ref) return null;
    const days = (Date.now() - new Date(ref).getTime()) / 86400000;
    if (days < 3) return { label: "Fresh", cls: "good" };
    if (days < 14) return { label: "Active", cls: "" };
    return { label: "Aging", cls: "warn" };
  }

  function scoreBadge(opp) {
    if (opp.status === "speculative") {
      return `<span class="tag speculative-badge" title="Generated from a news signal — not a confirmed posting. Verify with the company.">💡 SPECULATIVE LEAD</span>`;
    }
    const s = opp.score || 0;
    const cls = s >= 70 ? "high" : s >= 40 ? "mid" : "low";
    return `<span class="score-badge ${cls}" title="Rule-based: freshness, completeness, credibility — not AI">SCORE ${s}</span>`;
  }

  function matchScore(opp) {
    const skills = Array.isArray(opp.skills) ? opp.skills : [];
    if (!skills.length || !myCapabilities.length) return { score: 0, matched: [] };
    const matched = skills.filter((s) => myCapabilities.some((m) => m.includes(s.toLowerCase()) || s.toLowerCase().includes(m)));
    return { score: matched.length / skills.length, matched };
  }

  function renderMiniCard(opp) {
    const tags = metaTags(opp);
    const div = document.createElement("div");
    div.className = "mini-card" + (opp.status === "speculative" ? " speculative" : "");
    div.dataset.id = opp.id;
    let matchBadge = "";
    if (myCapabilities.length) {
      const m = matchScore(opp);
      if (m.matched.length) {
        matchBadge = `<div style="font-size:0.7rem;color:#7c8bff;font-weight:700;margin-bottom:0.3rem;">🎯 Matches your skills: ${escapeHtml(m.matched.join(", "))}</div>`;
      }
    }
    const fresh = freshness(opp);
    const applyHref = opp.source_type === "user" && opp.posted_by ? `profile.html?id=${opp.posted_by}` : opp.url || null;
    const applyLabel = opp.source_type === "user" ? "view poster →" : opp.status === "speculative" ? "read the signal →" : "view / apply →";
    const isSaved = mySavedIds.has(opp.id);
    const dnaMatch = window.OH_applyEventBoost(myDna ? window.OH_computeDnaScore(opp, myDna) : 0, opp, myBoostProfile);
    div.innerHTML = `
      ${dnaMatch >= 20 || opp.government_level ? `<div class="score-row">
        ${dnaMatch >= 20 ? `<div class="score-pill match"><span class="sp-label">Match</span><span class="sp-value">${dnaMatch}%</span></div>` : ""}
        ${window.OH_trustBadgeHtml ? window.OH_trustBadgeHtml(opp) : ""}
      </div>` : ""}
      ${matchBadge}
      <div class="mc-title"><a href="opportunity.html?id=${opp.id}" style="text-decoration:none;color:inherit;">${escapeHtml(oppLabel(opp))}</a></div>
      ${opp.company ? `<div style="margin:0.1rem 0;">${window.OH_companyLinkHtml(opp.company)}</div>` : ""}
      <div class="mc-meta">
        ${scoreBadge(opp)}
        ${fresh ? `<span class="tag ${fresh.cls}">${fresh.label}</span>` : ""}
        ${tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join("")}
      </div>
      <div style="margin-top:0.5rem;display:flex;justify-content:space-between;align-items:center;gap:0.4rem;flex-wrap:wrap;">
        ${applyHref ? `<a class="card-link" href="${applyHref}" target="${opp.source_type === "user" ? "_self" : "_blank"}" rel="noopener">${applyLabel}</a>` : `<span></span>`}
        <div style="display:flex;gap:0.5rem;align-items:center;">
          <button type="button" class="save-btn ${isSaved ? "saved" : ""}" data-save-id="${opp.id}">${isSaved ? "★ saved" : "☆ save"}</button>
          <button type="button" class="report-link" data-report-id="${opp.id}">report</button>
        </div>
      </div>
    `;
    div.addEventListener("click", (e) => {
      if (e.target.closest(".report-link") || e.target.closest(".card-link") || e.target.closest(".save-btn") || e.target.closest("a")) return;
      focusOpportunity(opp);
    });
    div.querySelector(".report-link").addEventListener("click", (e) => { e.stopPropagation(); openReportModal(opp.id); });
    div.querySelector(".save-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!currentUser) { Auth.requireLogin(); return; }
      const btn = e.currentTarget;
      try {
        if (mySavedIds.has(opp.id)) {
          await Auth.unsaveOpportunity(currentUser.id, opp.id);
          mySavedIds.delete(opp.id);
          btn.textContent = "☆ save"; btn.classList.remove("saved");
        } else {
          await Auth.saveOpportunity(currentUser.id, opp.id);
          mySavedIds.add(opp.id);
          btn.textContent = "★ saved"; btn.classList.add("saved");
        }
      } catch (err) { alert("Could not update saved opportunities: " + (err.message || err)); }
    });
    const link = div.querySelector(".card-link");
    if (link) link.addEventListener("click", (e) => {
      e.stopPropagation();
      window.OH_logEvent(currentUser && currentUser.id, opp.id, "apply_click");
    });
    return div;
  }

  function focusOpportunity(opp) {
    document.querySelectorAll(".mini-card").forEach((el) => el.classList.toggle("active", el.dataset.id === opp.id));
    if (opp.latitude != null && opp.longitude != null && map) {
      map.flyTo([opp.latitude, opp.longitude], Math.max(map.getZoom(), 6), { duration: 0.6 });
    }
  }

  function stripTags(html) {
    const div = document.createElement("div");
    div.innerHTML = html || "";
    return (div.textContent || div.innerText || "").trim();
  }

  function popupHtml(opp) {
    const link = opp.source_type === "user" && opp.posted_by
      ? `<a href="profile.html?id=${opp.posted_by}">view poster</a>`
      : `<a href="opportunity.html?id=${opp.id}">view details</a>`;
    return `<b>${escapeHtml(oppLabel(opp))}</b>${escapeHtml(stripTags(opp.body).slice(0, 140))}<br>${link}`;
  }

  function applyFilters() {
    let list = allOpps;
    if (activeIndustry) list = list.filter((o) => o.industry_id === activeIndustry);
    if (activeType) list = list.filter((o) => o.opportunity_type === activeType);
    if (activeWorkMode) list = list.filter((o) => o.work_mode === activeWorkMode);
    if (activeExperience) list = list.filter((o) => o.experience_level === activeExperience);
    if (activeGovLevel) list = list.filter((o) => o.government_level === activeGovLevel);
    if (activeCategory === "government") {
      list = list.filter((o) => !!o.government_level);
    } else if (activeCategory === "funding") {
      list = list.filter((o) => /grant|funding|invest/i.test(((o.title || "") + " " + (o.body || ""))));
    } else if (activeCategory === "education") {
      list = list.filter((o) => /scholarship|training/i.test(((o.title || "") + " " + (o.body || ""))));
    } else if (CATEGORY_GROUPS[activeCategory]) {
      list = list.filter((o) => CATEGORY_GROUPS[activeCategory].includes(o.opportunity_type));
    }
    if (mapFilterIds) list = list.filter((o) => mapFilterIds.has(o.id));
    if (searchTerm) {
      const parsed = parseSearchQuery(searchTerm);
      if (parsed.workMode) list = list.filter((o) => o.work_mode === parsed.workMode);
      if (parsed.oppType) list = list.filter((o) => o.opportunity_type === parsed.oppType);
      if (parsed.freeText) {
        const q = parsed.freeText;
        list = list.filter(
          (o) =>
            (o.title || "").toLowerCase().includes(q) ||
            (o.body || "").toLowerCase().includes(q) ||
            (o.city || o.location || "").toLowerCase().includes(q) ||
            (Array.isArray(o.skills) ? o.skills.join(" ") : "").toLowerCase().includes(q)
        );
      }
    }
    if (sortMode === "match" && myCapabilities.length) {
      list = list.slice().sort((a, b) => matchScore(b).score - matchScore(a).score);
    } else if (sortMode === "score") {
      list = list.slice().sort((a, b) => (b.score || 0) - (a.score || 0));
    } else if (sortMode === "recommended") {
      // Blended ranking, not pure recency: opportunity score plus a
      // freshness component that decays over ~3 weeks, so a strong older
      // listing can still beat a weak brand-new one. Spec section 23:
      // "don't simply sort everything chronologically."
      const freshnessOf = (o) => {
        const ref = o.last_verified_at || o.created_at;
        if (!ref) return 0;
        const days = (Date.now() - new Date(ref).getTime()) / 86400000;
        return Math.max(0, 100 - days * 5);
      };
      list = list.slice().sort((a, b) => {
        const rankA = (a.score || 0) * 0.6 + freshnessOf(a) * 0.4;
        const rankB = (b.score || 0) * 0.6 + freshnessOf(b) * 0.4;
        return rankB - rankA;
      });
    }
    return list;
  }

  function render() {
    const grid = document.getElementById("opportunities");
    const countEl = document.getElementById("results-count");
    const noteEl = document.getElementById("map-filter-note");
    if (!grid || !countEl) return;
    const list = applyFilters();

    countEl.textContent = list.length + (list.length === 1 ? " opportunity" : " opportunities");
    if (noteEl) {
      if (mapFilterIds) {
        noteEl.innerHTML = `filtered to <b>${escapeHtml(mapFilterLabel)}</b> — <a href="#" id="clear-map-filter">clear</a>`;
        noteEl.style.display = "";
        const clearLink = document.getElementById("clear-map-filter");
        if (clearLink) clearLink.addEventListener("click", (e) => { e.preventDefault(); mapFilterIds = null; render(); });
      } else {
        noteEl.style.display = "none";
      }
    }

    grid.innerHTML = "";
    if (list.length === 0) {
      grid.innerHTML = '<div class="empty">No opportunities match. Try clearing filters, or <a href="post.html">post one</a>.</div>';
    } else {
      list.forEach((opp) => grid.appendChild(renderMiniCard(opp)));
    }

    if (!map) return;
    (clusterGroup || markerLayer).clearLayers();
    let withCoords = 0;
    const markers = [];
    list.forEach((opp) => {
      if (opp.latitude == null || opp.longitude == null) return;
      withCoords++;
      const marker = L.circleMarker([opp.latitude, opp.longitude], {
        radius: 7, weight: 2, color: "#5b6ef5", fillColor: "#5b6ef5", fillOpacity: 0.75,
      }).bindPopup(popupHtml(opp));
      marker._ohId = opp.id;
      marker._ohLabel = opp.city || opp.location || opp.country || "this area";
      markers.push(marker);
    });
    if (clusterGroup) clusterGroup.addLayers(markers);
    else markers.forEach((m) => m.addTo(markerLayer));

    if (withCoords === 0 && list.length > 0) countEl.textContent += " — none have map coordinates yet, shown as a list only";
  }

  function initMap() {
    const el = document.getElementById("leaflet-map");
    if (!el) return;
    map = L.map("leaflet-map", { worldCopyJump: true }).setView([20, 10], 2);
    L.tileLayer(
      "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
      { attribution: "Esri, HERE, Garmin, &copy; OpenStreetMap contributors", maxZoom: 16 }
    ).addTo(map);

    if (window.L.MarkerClusterGroup) {
      clusterGroup = L.markerClusterGroup({
        maxClusterRadius: 45,
        spiderfyOnMaxZoom: true,
        showCoverageOnHover: false,
      });
      // Clicking a cluster filters the feed to that cluster's opportunities
      // instead of only zooming — this is the map<->feed link from the spec.
      clusterGroup.on("clusterclick", (e) => {
        const ids = new Set(e.layer.getAllChildMarkers().map((m) => m._ohId));
        const labels = e.layer.getAllChildMarkers().map((m) => m._ohLabel);
        const commonLabel = labels.every((l) => l === labels[0]) ? labels[0] : `${ids.size} locations`;
        mapFilterIds = ids;
        mapFilterLabel = `${commonLabel} (${ids.size})`;
        render();
      });
      map.addLayer(clusterGroup);
    } else {
      markerLayer = L.layerGroup().addTo(map);
    }
  }

  async function loadIndustries(preselectId) {
    const mount = document.getElementById("industry-chips");
    if (!mount) return;
    if (!window.OH_CONFIGURED) { mount.innerHTML = ""; return; }
    try {
      const { data, error } = await window.sb.from("industries").select("id, name, slug").eq("status", "approved").order("name");
      if (error) throw error;
      mount.innerHTML = "";
      const allChip = document.createElement("span");
      allChip.className = "chip active";
      allChip.textContent = "All";
      allChip.addEventListener("click", () => {
        activeIndustry = null;
        mount.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
        allChip.classList.add("active");
        render();
      });
      mount.appendChild(allChip);
      let preselectChipEl = null;
      (data || []).forEach((ind) => {
        const chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = ind.name;
        chip.dataset.industryId = ind.id;
        chip.addEventListener("click", () => {
          activeIndustry = ind.id;
          mount.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
          chip.classList.add("active");
          render();
        });
        mount.appendChild(chip);
        if (preselectId && ind.id === preselectId) preselectChipEl = chip;
      });
      if (preselectChipEl) preselectChipEl.click();
    } catch (err) { mount.innerHTML = ""; }
  }

  function wireCategoryRow() {
    const mount = document.getElementById("category-row");
    if (!mount) return;
    mount.querySelectorAll(".category-pill").forEach((pill) => {
      pill.addEventListener("click", () => {
        mount.querySelectorAll(".category-pill").forEach((p) => p.classList.remove("active"));
        pill.classList.add("active");
        activeCategory = pill.dataset.category || "";
        render();
      });
    });
  }

  function wireChipRow(containerId, valueAttr, onPick) {
    const mount = document.getElementById(containerId);
    if (!mount) return;
    mount.querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        mount.querySelectorAll(".chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        onPick(chip.dataset[valueAttr] || "");
      });
    });
  }

  // Selects a static chip (type/workmode/experience) programmatically by
  // its data-* value, reusing the same click handler wireChipRow already
  // attached — used to restore a saved search or a logged-in user's
  // preferences when the page first loads.
  function preselectChip(containerId, dataAttr, value) {
    if (!value) return;
    const mount = document.getElementById(containerId);
    if (!mount) return;
    const chip = mount.querySelector(`.chip[data-${dataAttr}="${value}"]`);
    if (chip) chip.click();
  }

  async function loadFeed() {
    const updatedEl = document.getElementById("updated");
    const grid = document.getElementById("opportunities");
    if (!grid) return;
    if (!window.OH_CONFIGURED) {
      if (updatedEl) updatedEl.textContent = "awaiting setup";
      grid.innerHTML = '<div class="empty">Supabase isn\'t configured yet — see SETUP_GUIDE.md.</div>';
      return;
    }
    try {
      let query = window.sb
        .from("opportunities")
        .select("*, profiles:posted_by ( username ), industries:industry_id ( name )")
        .order("created_at", { ascending: false })
        .limit(300);
      query = showSpeculative ? query.in("status", ["active", "speculative"]) : query.eq("status", "active");
      const { data, error } = await query;
      if (error) throw error;
      if (updatedEl) updatedEl.textContent = "last updated: " + new Date().toLocaleString();
      allOpps = data || [];
      if (allOpps.length === 0) {
        grid.innerHTML = '<div class="empty">no opportunities yet. run the scraper (see SETUP_GUIDE.md) or <a href="post.html">post the first one</a>.</div>';
        return;
      }
      render();
    } catch (err) {
      if (updatedEl) updatedEl.textContent = "connection error";
      grid.innerHTML = `<div class="empty">could not load opportunities (${escapeHtml(err.message || String(err))}).</div>`;
    }
  }

  async function loadMyCapabilities() {
    if (!window.OH_CONFIGURED) return;
    currentUser = await Auth.getUser();
    if (!currentUser) return;
    try {
      const { data } = await window.sb.from("capabilities").select("skill").eq("profile_id", currentUser.id);
      myCapabilities = (data || []).map((c) => c.skill.toLowerCase());
      const matchOpt = document.getElementById("match-option");
      if (myCapabilities.length && matchOpt) matchOpt.style.display = "";
      mySavedIds = await Auth.getSavedIds(currentUser.id);
    } catch { /* no capabilities yet — matching just stays off */ }
    try {
      const profile = await Auth.getProfile(currentUser.id);
      myPreferences = (profile && profile.preferences) || {};
      myDna = profile && profile.onboarding_completed ? profile.dna : null;
      myBoostProfile = await window.OH_getEventBoostProfile(currentUser.id);
    } catch { myPreferences = {}; }
  }

  // Phase 3 — saved searches: builds the {industry,type,mode,exp,q,sort,
  // speculative} shape stored in saved_searches.query and used to build a
  // shareable deep link (?industry=&type=&mode=&exp=&q=&sort=&speculative=1).
  function buildCurrentQuery() {
    return {
      industry: activeIndustry || null,
      type: activeType || "",
      mode: activeWorkMode || "",
      exp: activeExperience || "",
      gov: activeGovLevel || "",
      q: searchTerm || "",
      sort: sortMode || "recommended",
      speculative: !!showSpeculative,
    };
  }

  function describeCurrentFilters() {
    const parts = [];
    const industryChip = document.querySelector("#industry-chips .chip.active");
    if (industryChip && industryChip.textContent !== "All") parts.push(industryChip.textContent);
    if (activeType) parts.push(OPPORTUNITY_TYPE_LABELS[activeType] || activeType);
    if (activeWorkMode) parts.push(WORK_MODE_LABELS[activeWorkMode] || activeWorkMode);
    if (activeExperience) parts.push(EXPERIENCE_LABELS[activeExperience] || activeExperience);
    if (activeGovLevel) parts.push(GOV_LEVEL_LABELS[activeGovLevel] || activeGovLevel);
    if (searchTerm) parts.push(`"${searchTerm}"`);
    return parts.length ? parts.join(" · ") : "All opportunities";
  }

  function wireSaveSearch() {
    const btn = document.getElementById("save-search-btn");
    if (!btn) return; // only present on the full filter bar (opportunities.html)
    btn.addEventListener("click", async () => {
      const msg = document.getElementById("save-search-msg");
      if (!currentUser) { Auth.requireLogin(); return; }
      const nameInput = document.getElementById("save-search-name");
      const name = (nameInput && nameInput.value.trim()) || describeCurrentFilters();
      btn.disabled = true;
      try {
        await Auth.saveSearch(currentUser.id, name, buildCurrentQuery());
        if (msg) { msg.className = "form-msg ok"; msg.textContent = `Saved as "${name}" — find it on your profile page.`; }
        if (nameInput) nameInput.value = "";
      } catch (err) {
        if (msg) { msg.className = "form-msg err"; msg.textContent = err.message || "Could not save search."; }
      } finally {
        btn.disabled = false;
      }
    });
  }

  // Applies, in priority order: (1) an explicit URL query string — a saved
  // search's deep link, or the older ?q=/?speculative=1 links from Signals
  // and the homepage's "Why This Matters" box; (2) failing that, a logged
  // -in user's saved preferences, as sensible defaults only (never search
  // text — a default search box would be confusing, not helpful).
  async function applyIncomingState() {
    const params = new URLSearchParams(window.location.search);
    const hasParams = ["industry", "type", "mode", "exp", "gov", "q", "sort", "speculative"].some((k) => params.has(k));
    const prefs = myPreferences || {};

    // Preferences only cover work mode / experience / sort / speculative —
    // no default industry or type, to keep the Preferences box on the
    // profile page from needing its own industries fetch.
    const industryId = params.get("industry") || null;
    const type = params.get("type") || "";
    const mode = params.get("mode") || (!hasParams && prefs.mode) || "";
    const exp = params.get("exp") || (!hasParams && prefs.exp) || "";
    const gov = params.get("gov") || "";
    const q = params.get("q") || "";
    const sort = params.get("sort") || (!hasParams && prefs.sort) || null;
    const speculative = params.get("speculative") === "1" || (!hasParams && !!prefs.speculative);

    if (industryId) await loadIndustries(industryId);
    else await loadIndustries();

    preselectChip("type-chips", "type", type);
    preselectChip("workmode-chips", "mode", mode);
    preselectChip("experience-chips", "exp", exp);
    preselectChip("gov-chips", "gov", gov);

    if (q) {
      const input = document.getElementById("search-input");
      if (input) input.value = q;
      searchTerm = q;
    }

    if (sort) {
      const sortSelect = document.getElementById("sort-select");
      if (sortSelect) sortSelect.value = sort;
      sortMode = sort;
    }

    const specToggle = document.getElementById("speculative-toggle");
    if (speculative && specToggle) {
      specToggle.checked = true;
      showSpeculative = true;
    }
  }

  let reportingOppId = null;
  function openReportModal(oppId) {
    reportingOppId = oppId;
    const msg = document.getElementById("report-msg");
    if (msg) { msg.textContent = ""; msg.className = "form-msg"; }
    const modal = document.getElementById("report-modal");
    if (modal) modal.style.display = "flex";
  }
  function closeReportModal() {
    const modal = document.getElementById("report-modal");
    if (modal) modal.style.display = "none";
  }

  function wireReportModal() {
    const cancelBtn = document.getElementById("report-cancel-btn");
    const modal = document.getElementById("report-modal");
    const submitBtn = document.getElementById("report-submit-btn");
    if (cancelBtn) cancelBtn.addEventListener("click", closeReportModal);
    if (modal) modal.addEventListener("click", (e) => { if (e.target.id === "report-modal") closeReportModal(); });
    if (submitBtn) {
      submitBtn.addEventListener("click", async () => {
        const msg = document.getElementById("report-msg");
        if (!window.OH_CONFIGURED) return;
        const user = await Auth.getUser();
        if (!user) { msg.className = "form-msg err"; msg.textContent = "Log in to report a listing."; return; }
        try {
          const { error } = await window.sb.from("reports").insert({
            opportunity_id: reportingOppId,
            reporter_id: user.id,
            reason: document.getElementById("report-reason").value,
            details: document.getElementById("report-details").value.trim(),
          });
          if (error) throw error;
          msg.className = "form-msg ok";
          msg.textContent = "Reported — thank you, we'll take a look.";
          setTimeout(closeReportModal, 1300);
        } catch (err) {
          msg.className = "form-msg err";
          msg.textContent = (err.message || "").includes("duplicate") ? "You've already reported this listing." : err.message || "Could not submit report.";
        }
      });
    }
  }

  async function initOpportunitiesFeed() {
    const searchInput = document.getElementById("search-input");
    if (searchInput) searchInput.addEventListener("input", (e) => { searchTerm = e.target.value.trim(); render(); });

    wireChipRow("workmode-chips", "mode", (v) => { activeWorkMode = v; render(); });
    wireChipRow("type-chips", "type", (v) => { activeType = v; render(); });
    wireChipRow("experience-chips", "exp", (v) => { activeExperience = v; render(); });
    wireChipRow("gov-chips", "gov", (v) => { activeGovLevel = v; render(); });

    const specToggle = document.getElementById("speculative-toggle");
    if (specToggle) specToggle.addEventListener("change", (e) => { showSpeculative = e.target.checked; loadFeed(); });

    const sortSelect = document.getElementById("sort-select");
    if (sortSelect) sortSelect.addEventListener("change", (e) => { sortMode = e.target.value; render(); });

    wireReportModal();
    wireSaveSearch();
    wireCategoryRow();
    initMap();
    await loadMyCapabilities();
    // loadIndustries() runs inside applyIncomingState() so a saved search's
    // industry (an id, not a chip that already exists in the DOM) can be
    // preselected the moment the chip list is built, instead of racing it.
    await applyIncomingState();
    await loadFeed();
  }

  // ---------- Foundation phase: DNA-based personalization ----------
  // Exposed so index.html/leads.html can reuse the same card renderer +
  // already-fetched opportunity list. Match/Quality/Confidence/trust-state
  // scoring itself now lives in supabase-client.js (window.OH_computeDnaScore
  // etc.) since every page needs it, not just this feed module.
  window.OH_renderCard = renderMiniCard;
  window.OH_getAllOpportunities = () => allOpps;
  window.OH_getCurrentUser = () => currentUser;

  window.initOpportunitiesFeed = initOpportunitiesFeed;
})();
