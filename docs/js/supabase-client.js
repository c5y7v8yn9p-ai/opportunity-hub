// OpportunityHub — shared Supabase client, auth helpers, and nav renderer.
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

  function showConfigWarning() {
    if (configured) return;
    const el = document.createElement("div");
    el.style.cssText =
      "border:2px solid #ff5555;color:#ff5555;background:rgba(255,0,0,0.05);" +
      "padding:0.8rem 1rem;margin:0.6rem;font-size:0.78rem;text-align:center;position:relative;z-index:10;";
    el.innerHTML =
      "SUPABASE NOT CONFIGURED — edit <code>docs/js/config.js</code> with your project URL + anon key. " +
      'See <a href="SETUP_GUIDE.md" style="color:#ff5555;text-decoration:underline;">SETUP_GUIDE.md</a>.';
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
  };
  window.Auth = Auth;

  // ---------- shared nav ----------
  async function renderNav(activeId) {
    const mount = document.getElementById("site-nav");
    if (!mount) return;

    const links = [
      { id: "feed", href: "index.html", label: "Feed" },
      { id: "post", href: "post.html", label: "Post Opportunity" },
      { id: "courses", href: "courses.html", label: "Courses" },
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
    widget.innerHTML =
      `<span class="who">signed in as <a href="profile.html?id=${user.id}">${escapeHtml(uname)}</a></span>` +
      '<button id="logout-btn">Log Out</button>';
    document.getElementById("logout-btn").addEventListener("click", async () => {
      await Auth.signOut();
      window.location.reload();
    });
  }
  window.renderNav = renderNav;

  document.addEventListener("DOMContentLoaded", showConfigWarning);
})();
