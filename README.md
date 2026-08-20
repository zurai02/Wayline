# Wayline

*One console. Every waypoint.*

A small, self-hosted custom browser: tabs (with real per-tab back/forward
history), a bookmark rail, a new-tab dashboard, and a built-in embed proxy
that helps pages load inside the console even when they'd normally refuse
to be framed.

## Files

```
wayline-browser/
├── server.js           Node/Express server + /api/fetch embed proxy
├── package.json         Dependency manifest (Express)
├── config.json          App name, search engine, home links, theme tokens
├── start.sh              One-command launcher (npm install + npm start)
├── public/
│   ├── index.html        Console shell markup
│   ├── css/style.css     Theme: amber/teal mission-console, LCD address bar
│   └── js/app.js         Tabs, history, bookmarks, navigation logic
└── README.md
```

## Run it

Requires [Node.js](https://nodejs.org/) 18+.

```bash
cd wayline-browser
./start.sh          # installs dependencies on first run, then starts the server
# or choose a port:
./start.sh 5000
```

Then open **http://localhost:4173** (or whatever port you chose).

If you'd rather run the steps yourself:

```bash
npm install
npm start
```

## How it works

- **Tabs** — each tab tracks its own history stack, so back/forward is per
  tab, not global. State (tabs, active tab, bookmarks) is saved to
  `localStorage`, so reloading the page picks up where you left off.
- **Address bar** — type a URL or a search term. Bare domains like
  `example.com` are detected and treated as URLs; anything else is sent to
  the configured search engine (`config.json → defaultSearchEngine`).
- **Embed proxy** (`/api/fetch`) — many sites send an `X-Frame-Options` or
  CSP header that blocks direct `<iframe>` embedding. The server fetches
  the page itself, strips that blocker, injects a `<base>` tag so relative
  links/assets still resolve, and hands the HTML back to the iframe. If a
  page still can't load (some sites block by other means, or aren't HTML),
  Wayline shows a fallback with an "open in a new tab" link instead of a
  blank screen.
- **Bookmarks** — the star key in the nav row bookmarks the current page;
  bookmarked pages show up as chips in the rail underneath.

## Configuration

Edit `config.json`:

- `defaultSearchEngine` / `searchEngines` — add or change search providers.
- `homeLinks` — the quick links shown on the new-tab dashboard.
- `theme` — the color/font tokens used by the UI (mirrored in
  `public/css/style.css`; the JSON copy is there for anything you want to
  read the palette from programmatically).
- `proxy.enabled` — set to `false` to disable the embed proxy and load
  pages directly (simpler, but more sites will refuse to frame).

## Notes

- This proxy fetches pages **server-side on your own machine** — you're
  responsible for respecting the terms of service of any site you load
  through it.
- Some pages depend on cookies, login sessions, or JS behavior that a
  proxied fetch won't fully replicate. For those, use the "open in a new
  tab" fallback link.
