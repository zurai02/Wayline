/**
 * Wayline Browser — app.js
 * Multi-tab client logic. Each tab keeps its own back/forward history.
 * Persists tabs/bookmarks/history across reloads via localStorage
 * (this is a real standalone app served by server.js, not a sandboxed
 * chat artifact, so localStorage is the right tool here).
 */
(() => {
  "use strict";

  const STORAGE_KEY = "wayline:state:v1";
  let CONFIG = null;

  const el = {
    tabStrip: document.getElementById("tabStrip"),
    newTabBtn: document.getElementById("newTabBtn"),
    backBtn: document.getElementById("backBtn"),
    fwdBtn: document.getElementById("fwdBtn"),
    reloadBtn: document.getElementById("reloadBtn"),
    homeBtn: document.getElementById("homeBtn"),
    bookmarkBtn: document.getElementById("bookmarkBtn"),
    bookmarkIcon: document.getElementById("bookmarkIcon"),
    addressForm: document.getElementById("addressForm"),
    addressInput: document.getElementById("addressInput"),
    lcdStatus: document.getElementById("lcdStatus"),
    bookmarkRail: document.getElementById("bookmarkRail"),
    viewport: document.getElementById("viewport"),
    statusText: document.getElementById("statusText"),
    dashboardTemplate: document.getElementById("dashboardTemplate"),
  };

  /** @type {{tabs: Array, activeTabId: string, bookmarks: Array}} */
  let state = { tabs: [], activeTabId: null, bookmarks: [] };

  // ---------------- persistence ----------------

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.tabs) && parsed.tabs.length) {
          return parsed;
        }
      }
    } catch (e) {
      console.warn("Wayline: could not read saved state", e);
    }
    return null;
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("Wayline: could not persist state", e);
    }
  }

  // ---------------- tab model ----------------

  function makeTab(url = null) {
    return {
      id: "t" + Math.random().toString(36).slice(2, 10),
      history: url ? [url] : [],
      historyIndex: url ? 0 : -1,
      title: url ? url : "New Tab",
      loading: false,
      isDashboard: !url,
    };
  }

  function activeTab() {
    return state.tabs.find((t) => t.id === state.activeTabId) || null;
  }

  function currentUrl(tab) {
    if (!tab || tab.historyIndex < 0) return null;
    return tab.history[tab.historyIndex];
  }

  // ---------------- tab actions ----------------

  function openTab(url = null, activate = true) {
    const tab = makeTab(url);
    state.tabs.push(tab);
    if (activate) state.activeTabId = tab.id;
    renderTabs();
    renderActiveTab();
    saveState();
    return tab;
  }

  function closeTab(id) {
    const idx = state.tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const wasActive = state.activeTabId === id;
    state.tabs.splice(idx, 1);

    if (state.tabs.length === 0) {
      openTab(null, true);
      return;
    }

    if (wasActive) {
      const nextIdx = Math.max(0, idx - 1);
      state.activeTabId = state.tabs[nextIdx].id;
    }
    renderTabs();
    renderActiveTab();
    saveState();
  }

  function switchTab(id) {
    state.activeTabId = id;
    renderTabs();
    renderActiveTab();
    saveState();
  }

  function navigate(tab, rawInput) {
    const resolved = resolveAddress(rawInput);
    // truncate forward history when navigating from a mid-point
    tab.history = tab.history.slice(0, tab.historyIndex + 1);
    tab.history.push(resolved);
    tab.historyIndex = tab.history.length - 1;
    tab.isDashboard = false;
    tab.title = resolved;
    tab.loading = true;
    renderTabs();
    renderActiveTab();
    saveState();
  }

  function goBack(tab) {
    if (!tab || tab.historyIndex <= 0) return;
    tab.historyIndex -= 1;
    tab.isDashboard = false;
    tab.loading = true;
    renderTabs();
    renderActiveTab();
    saveState();
  }

  function goForward(tab) {
    if (!tab || tab.historyIndex >= tab.history.length - 1) return;
    tab.historyIndex += 1;
    tab.loading = true;
    renderTabs();
    renderActiveTab();
    saveState();
  }

  function goHome(tab) {
    tab.isDashboard = true;
    renderActiveTab();
    saveState();
  }

  function reload(tab) {
    if (!tab || tab.isDashboard) return;
    tab.loading = true;
    renderTabs();
    renderActiveTab(true);
  }

  // ---------------- address resolution ----------------

  function looksLikeUrl(input) {
    if (/^https?:\/\//i.test(input)) return true;
    // bare domain, e.g. "example.com" or "example.com/path"
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(input.trim());
  }

  function resolveAddress(input) {
    const trimmed = input.trim();
    if (!trimmed) return "";
    if (looksLikeUrl(trimmed)) {
      return /^https?:\/\//i.test(trimmed) ? trimmed : "https://" + trimmed;
    }
    const engineKey = CONFIG.defaultSearchEngine;
    const template = CONFIG.searchEngines[engineKey];
    return template.replace("%s", encodeURIComponent(trimmed));
  }

  // ---------------- rendering: tab strip ----------------

  function renderTabs() {
    el.tabStrip.innerHTML = "";
    state.tabs.forEach((tab) => {
      const div = document.createElement("div");
      div.className = "tab" + (tab.id === state.activeTabId ? " active" : "") + (tab.loading ? " loading" : "");
      div.setAttribute("role", "tab");
      div.setAttribute("tabindex", "0");
      div.title = currentUrl(tab) || "New Tab";

      const fav = document.createElement("span");
      fav.className = "tab-favicon";

      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = tab.isDashboard ? "New Tab" : shortTitle(tab.title);

      const close = document.createElement("span");
      close.className = "tab-close";
      close.innerHTML = "&times;";
      close.setAttribute("aria-label", "Close tab");
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        closeTab(tab.id);
      });

      div.appendChild(fav);
      div.appendChild(title);
      div.appendChild(close);
      div.addEventListener("click", () => switchTab(tab.id));

      el.tabStrip.appendChild(div);
    });
  }

  function shortTitle(url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname : "");
    } catch (e) {
      return url;
    }
  }

  // ---------------- rendering: active tab body ----------------

  function renderActiveTab(forceReload = false) {
    const tab = activeTab();
    el.viewport.innerHTML = "";

    if (!tab) return;

    updateNavKeys(tab);
    updateBookmarkKey(tab);

    if (tab.isDashboard || tab.historyIndex < 0) {
      renderDashboard();
      setStatus("Ready.");
      setLcdStatus("idle");
      el.addressInput.value = "";
      return;
    }

    const url = currentUrl(tab);
    el.addressInput.value = url;
    setLcdStatus("loading");
    setStatus("Loading " + url + " …");

    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups");
    iframe.referrerPolicy = "no-referrer";
    const proxied = "/api/fetch?url=" + encodeURIComponent(url) + (forceReload ? "&_t=" + Date.now() : "");
    iframe.src = proxied;

    let settled = false;
    const failSafeTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      showBlocked(url);
    }, 12000);

    iframe.addEventListener("load", () => {
      if (settled) return;
      settled = true;
      clearTimeout(failSafeTimer);
      tab.loading = false;
      renderTabs();
      setLcdStatus("idle");
      setStatus(url);
    });

    el.viewport.appendChild(iframe);
  }

  function showBlocked(url) {
    el.viewport.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "frame-blocked";
    wrap.innerHTML = `
      <div>This waypoint wouldn't load inside the console.</div>
      <div><a href="${url}" target="_blank" rel="noopener">Open it in a new browser tab instead →</a></div>
    `;
    el.viewport.appendChild(wrap);
    setLcdStatus("blocked");
    setStatus("Blocked: " + url);
    const tab = activeTab();
    if (tab) {
      tab.loading = false;
      renderTabs();
    }
  }

  function renderDashboard() {
    const frag = el.dashboardTemplate.content.cloneNode(true);
    frag.getElementById("dashTagline").textContent = CONFIG.tagline || "One console. Every waypoint.";

    const linksWrap = frag.getElementById("dashLinks");
    (CONFIG.homeLinks || []).forEach((link) => {
      const a = document.createElement("div");
      a.className = "dashboard-link";
      a.innerHTML = `<span class="glyph">${link.label.charAt(0)}</span><span>${link.label}</span>`;
      a.addEventListener("click", () => {
        const tab = activeTab();
        navigate(tab, link.url);
      });
      linksWrap.appendChild(a);
    });

    const form = frag.getElementById("dashSearchForm");
    const input = frag.getElementById("dashSearchInput");
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!input.value.trim()) return;
      const tab = activeTab();
      navigate(tab, input.value);
    });

    el.viewport.appendChild(frag);
    setTimeout(() => input && input.focus(), 30);
  }

  // ---------------- nav keys / status ----------------

  function updateNavKeys(tab) {
    el.backBtn.disabled = !tab || tab.historyIndex <= 0;
    el.fwdBtn.disabled = !tab || tab.historyIndex >= tab.history.length - 1;
  }

  function updateBookmarkKey(tab) {
    const url = tab && !tab.isDashboard ? currentUrl(tab) : null;
    const isBookmarked = url && state.bookmarks.some((b) => b.url === url);
    el.bookmarkBtn.classList.toggle("active", !!isBookmarked);
    el.bookmarkBtn.disabled = !url;
  }

  function setStatus(text) {
    el.statusText.textContent = text;
  }

  function setLcdStatus(mode) {
    el.lcdStatus.classList.remove("loading", "blocked");
    if (mode === "loading") el.lcdStatus.classList.add("loading");
    if (mode === "blocked") el.lcdStatus.classList.add("blocked");
  }

  // ---------------- bookmarks ----------------

  function toggleBookmark() {
    const tab = activeTab();
    if (!tab || tab.isDashboard) return;
    const url = currentUrl(tab);
    const idx = state.bookmarks.findIndex((b) => b.url === url);
    if (idx >= 0) {
      state.bookmarks.splice(idx, 1);
    } else {
      state.bookmarks.push({ url, label: shortTitle(url) });
    }
    renderBookmarkRail();
    updateBookmarkKey(tab);
    saveState();
  }

  function renderBookmarkRail() {
    el.bookmarkRail.innerHTML = "";
    state.bookmarks.forEach((b) => {
      const chip = document.createElement("div");
      chip.className = "bookmark-chip";
      chip.innerHTML = `<span class="dot"></span><span>${b.label}</span>`;
      chip.addEventListener("click", () => {
        const tab = activeTab();
        navigate(tab, b.url);
      });
      el.bookmarkRail.appendChild(chip);
    });
  }

  // ---------------- wiring ----------------

  function wireEvents() {
    el.newTabBtn.addEventListener("click", () => openTab(null, true));

    el.addressForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const val = el.addressInput.value;
      if (!val.trim()) return;
      const tab = activeTab();
      navigate(tab, val);
    });

    el.backBtn.addEventListener("click", () => goBack(activeTab()));
    el.fwdBtn.addEventListener("click", () => goForward(activeTab()));
    el.reloadBtn.addEventListener("click", () => reload(activeTab()));
    el.homeBtn.addEventListener("click", () => goHome(activeTab()));
    el.bookmarkBtn.addEventListener("click", toggleBookmark);

    document.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "t") {
        e.preventDefault();
        openTab(null, true);
      } else if (mod && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (state.activeTabId) closeTab(state.activeTabId);
      } else if (mod && e.key.toLowerCase() === "r") {
        e.preventDefault();
        reload(activeTab());
      } else if (mod && e.key === "l") {
        e.preventDefault();
        el.addressInput.focus();
        el.addressInput.select();
      }
    });
  }

  // ---------------- boot ----------------

  async function loadConfig() {
    try {
      const res = await fetch("/config.json");
      CONFIG = await res.json();
    } catch (e) {
      CONFIG = {
        tagline: "One console. Every waypoint.",
        defaultSearchEngine: "duckduckgo",
        searchEngines: { duckduckgo: "https://duckduckgo.com/html/?q=%s" },
        homeLinks: [],
      };
    }
  }

  async function boot() {
    await loadConfig();

    const saved = loadState();
    if (saved) {
      state = saved;
      if (!state.tabs.length) state.tabs = [makeTab(null)];
      if (!state.activeTabId || !state.tabs.some((t) => t.id === state.activeTabId)) {
        state.activeTabId = state.tabs[0].id;
      }
    } else {
      const tab = makeTab(null);
      state = { tabs: [tab], activeTabId: tab.id, bookmarks: [] };
    }

    wireEvents();
    renderTabs();
    renderBookmarkRail();
    renderActiveTab();
  }

  boot();
})();
