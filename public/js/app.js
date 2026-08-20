/**
 * Wayline Browser v2.0 — Enhanced Client
 * Multi-tab browser with real favicons, drag-drop, autocomplete,
 * context menus, better proxy handling, and session recovery.
 */
(() => {
  "use strict";

  const STORAGE_KEY = "wayline:state:v2";
  const HISTORY_KEY = "wayline:history:v1";
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
    contextMenu: document.getElementById("contextMenu"),
  };

  /** @type {{tabs: Array, activeTabId: string, bookmarks: Array}} */
  let state = { tabs: [], activeTabId: null, bookmarks: [] };
  let urlHistory = []; // For autocomplete
  let dragSrcEl = null;
  let ctxTabId = null;

  // ── Persistence ──

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

  function loadUrlHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) urlHistory = JSON.parse(raw);
    } catch (e) { urlHistory = []; }
  }

  function saveUrlHistory() {
    try {
      // Deduplicate and keep last 200
      const seen = new Set();
      const deduped = [];
      for (let i = urlHistory.length - 1; i >= 0; i--) {
        if (!seen.has(urlHistory[i].url)) {
          seen.add(urlHistory[i].url);
          deduped.unshift(urlHistory[i]);
        }
        if (deduped.length >= 200) break;
      }
      urlHistory = deduped;
      localStorage.setItem(HISTORY_KEY, JSON.stringify(urlHistory));
    } catch (e) {}
  }

  function addToHistory(url, title) {
    urlHistory.push({ url, title: title || url, timestamp: Date.now() });
    saveUrlHistory();
  }

  // ── Tab Model ──

  function makeTab(url = null) {
    return {
      id: "t" + Math.random().toString(36).slice(2, 10),
      history: url ? [url] : [],
      historyIndex: url ? 0 : -1,
      title: url ? url : "New Tab",
      loading: false,
      isDashboard: !url,
      favicon: null,
    };
  }

  function activeTab() {
    return state.tabs.find((t) => t.id === state.activeTabId) || null;
  }

  function currentUrl(tab) {
    if (!tab || tab.historyIndex < 0) return null;
    return tab.history[tab.historyIndex];
  }

  // ── Tab Actions ──

  function openTab(url = null, activate = true, position = null) {
    const tab = makeTab(url);
    if (position !== null && position >= 0 && position <= state.tabs.length) {
      state.tabs.splice(position, 0, tab);
    } else {
      state.tabs.push(tab);
    }
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

  function closeOtherTabs(keepId) {
    state.tabs = state.tabs.filter((t) => t.id === keepId);
    state.activeTabId = keepId;
    renderTabs();
    renderActiveTab();
    saveState();
  }

  function duplicateTab(id) {
    const src = state.tabs.find((t) => t.id === id);
    if (!src) return;
    const url = currentUrl(src);
    const idx = state.tabs.findIndex((t) => t.id === id);
    openTab(url, true, idx + 1);
  }

  function switchTab(id) {
    state.activeTabId = id;
    renderTabs();
    renderActiveTab();
    saveState();
  }

  function navigate(tab, rawInput) {
    const resolved = resolveAddress(rawInput);
    if (!resolved) return;
    tab.history = tab.history.slice(0, tab.historyIndex + 1);
    tab.history.push(resolved);
    tab.historyIndex = tab.history.length - 1;
    tab.isDashboard = false;
    tab.title = resolved;
    tab.loading = true;
    tab.favicon = null;
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
    tab.isDashboard = false;
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

  // ── Address Resolution ──

  function looksLikeUrl(input) {
    if (/^https?:\/\//i.test(input)) return true;
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

  // ── Favicon ──

  function getFaviconUrl(pageUrl) {
    try {
      const u = new URL(pageUrl);
      return `https://www.google.com/s2/favicons?domain=${u.hostname}&sz=32`;
    } catch (e) {
      return null;
    }
  }

  // ── Rendering: Tab Strip ──

  function renderTabs() {
    el.tabStrip.innerHTML = "";
    state.tabs.forEach((tab, index) => {
      const div = document.createElement("div");
      div.className = "tab" + (tab.id === state.activeTabId ? " active" : "") + (tab.loading ? " loading" : "");
      div.setAttribute("role", "tab");
      div.setAttribute("tabindex", "0");
      div.setAttribute("draggable", "true");
      div.dataset.tabId = tab.id;
      div.dataset.index = index;
      div.title = currentUrl(tab) || "New Tab";

      // Favicon
      const fav = document.createElement("img");
      fav.className = "tab-favicon" + (tab.favicon ? "" : " fallback");
      if (tab.favicon) {
        fav.src = tab.favicon;
        fav.onerror = () => { fav.classList.add("fallback"); fav.src = ""; };
      } else if (!tab.isDashboard && currentUrl(tab)) {
        const favUrl = getFaviconUrl(currentUrl(tab));
        if (favUrl) {
          fav.src = favUrl;
          fav.onerror = () => { fav.classList.add("fallback"); fav.src = ""; };
        } else {
          fav.classList.add("fallback");
        }
      } else {
        fav.classList.add("fallback");
      }

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
      div.addEventListener("auxclick", (e) => {
        if (e.button === 1) { // Middle click
          e.preventDefault();
          closeTab(tab.id);
        }
      });
      div.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        showContextMenu(e, tab.id);
      });

      // Drag & Drop
      div.addEventListener("dragstart", (e) => {
        dragSrcEl = div;
        div.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
        e.dataTransfer.setData("text/plain", tab.id);
      });
      div.addEventListener("dragend", () => {
        div.classList.remove("dragging");
        dragSrcEl = null;
        document.querySelectorAll(".tab").forEach(t => t.style.borderLeft = "");
      });
      div.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        const rect = div.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        if (e.clientX < mid) {
          div.style.borderLeft = "2px solid var(--accent)";
          div.style.borderRight = "";
        } else {
          div.style.borderLeft = "";
          div.style.borderRight = "2px solid var(--accent)";
        }
      });
      div.addEventListener("dragleave", () => {
        div.style.borderLeft = "";
        div.style.borderRight = "";
      });
      div.addEventListener("drop", (e) => {
        e.preventDefault();
        div.style.borderLeft = "";
        div.style.borderRight = "";
        const srcId = e.dataTransfer.getData("text/plain");
        if (srcId === tab.id) return;
        const srcIdx = state.tabs.findIndex(t => t.id === srcId);
        const dstIdx = state.tabs.findIndex(t => t.id === tab.id);
        if (srcIdx === -1 || dstIdx === -1) return;
        const rect = div.getBoundingClientRect();
        const mid = rect.left + rect.width / 2;
        const insertAfter = e.clientX >= mid;
        const [moved] = state.tabs.splice(srcIdx, 1);
        let newIdx = insertAfter ? dstIdx : dstIdx;
        if (srcIdx < dstIdx && !insertAfter) newIdx--;
        if (srcIdx > dstIdx && insertAfter) newIdx++;
        state.tabs.splice(newIdx, 0, moved);
        renderTabs();
        saveState();
      });

      el.tabStrip.appendChild(div);
    });
  }

  function shortTitle(url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, "") + (u.pathname !== "/" ? u.pathname : "");
    } catch (e) {
      return url.length > 40 ? url.slice(0, 40) + "..." : url;
    }
  }

  // ── Rendering: Active Tab Body ──

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
    setStatus("Loading " + shortTitle(url) + " …");

    const iframe = document.createElement("iframe");
    // Safer sandbox: no allow-same-origin to prevent security issues,
    // but allow scripts, forms, and popups
    iframe.setAttribute("sandbox", "allow-scripts allow-forms allow-popups allow-downloads");
    iframe.setAttribute("allow", "fullscreen");
    iframe.referrerPolicy = "no-referrer";
    iframe.title = tab.title || "Wayline View";

    const proxied = "/api/fetch?url=" + encodeURIComponent(url) + (forceReload ? "&_t=" + Date.now() : "");
    iframe.src = proxied;

    // Listen for navigation messages from injected script
    window.addEventListener("message", (e) => {
      if (e.data && e.data.type === "wayline-nav" && e.data.url) {
        const active = activeTab();
        if (active && active.id === tab.id && !active.isDashboard) {
          // Update history if SPA navigated
          if (e.data.url !== currentUrl(active)) {
            active.history = active.history.slice(0, active.historyIndex + 1);
            active.history.push(e.data.url);
            active.historyIndex = active.history.length - 1;
            active.title = e.data.url;
            el.addressInput.value = e.data.url;
            addToHistory(e.data.url, active.title);
            saveState();
          }
        }
      }
    });

    let settled = false;
    const failSafeTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      showBlocked(url);
    }, 15000);

    iframe.addEventListener("load", () => {
      if (settled) return;
      settled = true;
      clearTimeout(failSafeTimer);
      tab.loading = false;
      renderTabs();
      setLcdStatus("idle");
      setStatus(url);
      addToHistory(url, tab.title);

      // Try to extract title from iframe (may fail due to sandbox)
      try {
        const iframeTitle = iframe.contentDocument?.title;
        if (iframeTitle && iframeTitle !== tab.title) {
          tab.title = iframeTitle;
          renderTabs();
          saveState();
        }
      } catch (e) {}
    });

    iframe.addEventListener("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(failSafeTimer);
      showBlocked(url);
    });

    el.viewport.appendChild(iframe);
  }

  function showBlocked(url) {
    el.viewport.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "frame-blocked";
    wrap.innerHTML = `
      <h2>⚠ WAYPOINT UNREACHABLE</h2>
      <p>This waypoint wouldn't load inside the console.<br>The site may block embedding, require login, or use complex JavaScript.</p>
      <p><a href="${url}" target="_blank">Open ${shortTitle(url)} in system browser →</a></p>
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
      a.innerHTML = `<span class="glyph">${link.label.charAt(0)}</span>${link.label}`;
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

  // ── Nav Keys / Status ──

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

  // ── Autocomplete ──

  function setupAutocomplete() {
    let dropdown = document.querySelector(".autocomplete-dropdown");
    if (!dropdown) {
      dropdown = document.createElement("div");
      dropdown.className = "autocomplete-dropdown";
      el.addressForm.style.position = "relative";
      el.addressForm.appendChild(dropdown);
    }

    let activeIndex = -1;
    let items = [];

    function showSuggestions(query) {
      if (!query.trim()) {
        dropdown.classList.remove("visible");
        return;
      }
      const q = query.toLowerCase();
      const matches = urlHistory
        .filter(h => h.url.toLowerCase().includes(q) || (h.title && h.title.toLowerCase().includes(q)))
        .slice(0, 8);

      if (matches.length === 0) {
        dropdown.classList.remove("visible");
        return;
      }

      dropdown.innerHTML = "";
      items = matches;
      activeIndex = -1;

      matches.forEach((item, i) => {
        const div = document.createElement("div");
        div.className = "autocomplete-item";
        div.innerHTML = `
          <svg class="ac-icon" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 2l1.5 4h4L9.5 8.5l1.5 4L7 10l-4 2.5 1.5-4L1.5 6h4z"/></svg>
          <span>${escapeHtml(shortTitle(item.title || item.url))}</span>
          <span class="ac-url">${escapeHtml(shortTitle(item.url))}</span>
        `;
        div.addEventListener("click", () => {
          const tab = activeTab();
          navigate(tab, item.url);
          dropdown.classList.remove("visible");
          el.addressInput.blur();
        });
        div.addEventListener("mouseenter", () => { activeIndex = i; highlight(); });
        dropdown.appendChild(div);
      });

      dropdown.classList.add("visible");
    }

    function highlight() {
      dropdown.querySelectorAll(".autocomplete-item").forEach((item, i) => {
        item.classList.toggle("active", i === activeIndex);
      });
    }

    el.addressInput.addEventListener("input", () => {
      showSuggestions(el.addressInput.value);
    });

    el.addressInput.addEventListener("keydown", (e) => {
      if (!dropdown.classList.contains("visible")) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, items.length - 1);
        highlight();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        highlight();
      } else if (e.key === "Enter" && activeIndex >= 0) {
        e.preventDefault();
        const tab = activeTab();
        navigate(tab, items[activeIndex].url);
        dropdown.classList.remove("visible");
      } else if (e.key === "Escape") {
        dropdown.classList.remove("visible");
      }
    });

    el.addressInput.addEventListener("blur", () => {
      setTimeout(() => dropdown.classList.remove("visible"), 200);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Bookmarks ──

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
      chip.innerHTML = `<span class="dot"></span>${escapeHtml(b.label)}`;
      chip.addEventListener("click", () => {
        const tab = activeTab();
        navigate(tab, b.url);
      });
      chip.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        if (confirm(`Delete bookmark "${b.label}"?`)) {
          state.bookmarks = state.bookmarks.filter(x => x.url !== b.url);
          renderBookmarkRail();
          updateBookmarkKey(activeTab());
          saveState();
        }
      });
      el.bookmarkRail.appendChild(chip);
    });
  }

  // ── Context Menu ──

  function showContextMenu(e, tabId) {
    ctxTabId = tabId;
    const menu = el.contextMenu;
    menu.style.display = "block";
    menu.style.left = Math.min(e.clientX, window.innerWidth - 180) + "px";
    menu.style.top = Math.min(e.clientY, window.innerHeight - 140) + "px";
  }

  function hideContextMenu() {
    el.contextMenu.style.display = "none";
    ctxTabId = null;
  }

  // ── Wiring ──

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

    // Context menu actions
    el.contextMenu.addEventListener("click", (e) => {
      const action = e.target.dataset.action;
      if (!action || !ctxTabId) return;
      if (action === "reload") {
        const tab = state.tabs.find(t => t.id === ctxTabId);
        if (tab) reload(tab);
      } else if (action === "duplicate") {
        duplicateTab(ctxTabId);
      } else if (action === "close") {
        closeTab(ctxTabId);
      } else if (action === "close-others") {
        closeOtherTabs(ctxTabId);
      }
      hideContextMenu();
    });

    document.addEventListener("click", (e) => {
      if (!el.contextMenu.contains(e.target)) hideContextMenu();
    });

    document.addEventListener("keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      const alt = e.altKey;

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
      } else if (mod && e.key.toLowerCase() === "d") {
        e.preventDefault();
        toggleBookmark();
      } else if (mod && e.key === "Tab") {
        e.preventDefault();
        const idx = state.tabs.findIndex(t => t.id === state.activeTabId);
        if (idx === -1) return;
        let next;
        if (e.shiftKey) {
          next = idx > 0 ? idx - 1 : state.tabs.length - 1;
        } else {
          next = idx < state.tabs.length - 1 ? idx + 1 : 0;
        }
        switchTab(state.tabs[next].id);
      } else if (alt && e.key === "ArrowLeft") {
        e.preventDefault();
        goBack(activeTab());
      } else if (alt && e.key === "ArrowRight") {
        e.preventDefault();
        goForward(activeTab());
      }
    });
  }

  // ── Boot ──

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
    loadUrlHistory();

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
    setupAutocomplete();
    renderTabs();
    renderBookmarkRail();
    renderActiveTab();
  }

  boot();
})();
