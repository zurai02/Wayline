/**
 * Wayline Browser — Enhanced Server
 * Smart embed proxy with content-type handling, cookie simulation,
 * URL rewriting, binary passthrough, and graceful errors.
 */
const express = require("express");
const http = require("http");
const https = require("https");
const url = require("url");
const path = require("path");
const fs = require("fs");

const app = express();

// Load config
let CONFIG = {};
try {
  CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
} catch (e) {
  console.warn("Could not load config.json, using defaults");
  CONFIG = { port: 4173, proxy: { enabled: true, userAgent: "Mozilla/5.0 (compatible; WaylineBrowser/2.0)" } };
}

const PORT = process.env.PORT || process.argv[2] || CONFIG.port || 4173;
const USER_AGENT = CONFIG.proxy?.userAgent || "Mozilla/5.0 (compatible; WaylineBrowser/2.0)";
const PROXY_ENABLED = CONFIG.proxy?.enabled !== false;

// In-memory cookie store (per-domain)
const cookieJar = new Map();

// Helper: fetch with follow redirects, cookies, and timeout
function smartFetch(targetUrl, options = {}) {
  return new Promise((resolve, reject) => {
    const maxRedirects = options.maxRedirects || 5;
    const timeout = options.timeout || 15000;

    function doFetch(currentUrl, redirectsLeft) {
      const parsed = url.parse(currentUrl);
      const isHttps = parsed.protocol === "https:";
      const client = isHttps ? https : http;

      // Get cookies for this domain
      const domain = parsed.hostname;
      const cookies = cookieJar.get(domain) || [];

      const reqOptions = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.path,
        method: "GET",
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Accept-Encoding": "identity",
          "Connection": "keep-alive",
          "Upgrade-Insecure-Requests": "1",
          ...(cookies.length ? { "Cookie": cookies.join("; ") } : {}),
          ...(options.referer ? { "Referer": options.referer } : {}),
        },
        timeout: timeout,
        rejectUnauthorized: false, // Allow self-signed certs (dev convenience)
      };

      const req = client.request(reqOptions, (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (redirectsLeft > 0) {
            const redirectUrl = url.resolve(currentUrl, res.headers.location);
            return doFetch(redirectUrl, redirectsLeft - 1);
          }
          return reject(new Error("Too many redirects"));
        }

        // Store cookies
        const setCookies = res.headers["set-cookie"];
        if (setCookies) {
          const existing = cookieJar.get(domain) || [];
          const newCookies = setCookies.map(c => c.split(";")[0].trim());
          cookieJar.set(domain, [...existing, ...newCookies]);
        }

        resolve({ res, finalUrl: currentUrl });
      });

      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timeout"));
      });
      req.end();
    }

    doFetch(targetUrl, maxRedirects);
  });
}

// Determine if content is HTML
function isHtml(contentType) {
  if (!contentType) return false;
  return contentType.includes("text/html") || contentType.includes("application/xhtml");
}

// Determine if content is text-based (can be modified)
function isTextContent(contentType) {
  if (!contentType) return true;
  const textTypes = [
    "text/", "application/javascript", "application/json",
    "application/xml", "application/xhtml", "image/svg"
  ];
  return textTypes.some(t => contentType.includes(t));
}

// Rewrite URLs in HTML/CSS/JS to go through proxy
function rewriteUrls(body, baseUrl, proxyPrefix) {
  const parsedBase = url.parse(baseUrl);
  const baseOrigin = `${parsedBase.protocol}//${parsedBase.host}`;

  // Rewrite absolute URLs to same origin through proxy
  // Match href="http..." src="http..." url(http...) etc.

  // href/src/action attributes
  body = body.replace(
    /(href|src|action|poster|data-src|data-href)=['"](https?:\/\/[^'"]+)['"]/gi,
    (match, attr, targetUrl) => {
      // Don't proxy data URIs or javascript:
      if (targetUrl.startsWith("data:") || targetUrl.startsWith("javascript:")) return match;
      return `${attr}="${proxyPrefix}${encodeURIComponent(targetUrl)}"`;
    }
  );

  // CSS url() references
  body = body.replace(
    /url\(['"]?(https?:\/\/[^'"\)]+)['"]?\)/gi,
    (match, targetUrl) => {
      if (targetUrl.startsWith("data:")) return match;
      return `url(${proxyPrefix}${encodeURIComponent(targetUrl)})`;
    }
  );

  // Relative URLs - convert to absolute then proxy
  body = body.replace(
    /(href|src|action)=['"](\/[^'"]+)['"]/gi,
    (match, attr, relativePath) => {
      const absolute = url.resolve(baseUrl, relativePath);
      return `${attr}="${proxyPrefix}${encodeURIComponent(absolute)}"`;
    }
  );

  // CSS relative url()
  body = body.replace(
    /url\(['"]?([^'"\)/][^'"\)]*)['"]?\)/gi,
    (match, relativePath) => {
      // Skip already-absolute, data URIs, and already-proxied
      if (relativePath.startsWith("http") || relativePath.startsWith("data:") || relativePath.startsWith("/api/fetch")) return match;
      const absolute = url.resolve(baseUrl, relativePath);
      return `url(${proxyPrefix}${encodeURIComponent(absolute)})`;
    }
  );

  // Fix base tag if present, otherwise inject one
  if (!/<base[^>]*>/i.test(body)) {
    // Inject base tag in head
    body = body.replace(/<head[^>]*>/i, match => `${match}\n<base href="${baseOrigin}/" target="_self">`);
  }

  // Inject script to fix window.location for SPAs
  const locationFix = `
<script data-wayline-injected="true">
(function() {
  // Wayline proxy location fix
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;
  history.pushState = function() { originalPushState.apply(this, arguments); window.parent.postMessage({type:'wayline-nav', url:location.href}, '*'); };
  history.replaceState = function() { originalReplaceState.apply(this, arguments); window.parent.postMessage({type:'wayline-nav', url:location.href}, '*'); };
  // Intercept link clicks to stay in iframe
  document.addEventListener('click', function(e) {
    const a = e.target.closest('a');
    if (a && a.href && !a.href.startsWith('javascript:') && !a.href.startsWith('data:') && !a.href.startsWith('#') && !a.target) {
      const isExternal = !a.href.includes('${parsedBase.hostname}');
      if (isExternal) {
        a.target = '_blank';
      }
    }
  });
})();
</script>`;

  // Inject before closing </head> or at start of <body>
  if (/<\/head>/i.test(body)) {
    body = body.replace(/<\/head>/i, locationFix + "\n</head>");
  } else if (/<body/i.test(body)) {
    body = body.replace(/<body[^>]*>/i, match => match + locationFix);
  } else {
    body = locationFix + body;
  }

  // Remove frame-busting scripts
  body = body.replace(/if\s*\(\s*top\s*!==\s*self\s*\)/gi, "if (false)");
  body = body.replace(/if\s*\(\s*self\s*!==\s*top\s*\)/gi, "if (false)");
  body = body.replace(/top\.location\s*=\s*self\.location/gi, "/* wayline-blocked */");

  return body;
}

// Proxy endpoint
app.get("/api/fetch", async (req, res) => {
  if (!PROXY_ENABLED) {
    return res.status(403).json({ error: "Proxy disabled" });
  }

  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  // Security: only allow http/https
  let decodedUrl;
  try {
    decodedUrl = decodeURIComponent(targetUrl);
    const parsed = url.parse(decodedUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return res.status(400).json({ error: "Invalid protocol" });
    }
  } catch (e) {
    return res.status(400).json({ error: "Invalid URL" });
  }

  try {
    const { res: upstreamRes, finalUrl } = await smartFetch(decodedUrl, {
      referer: req.headers.referer,
    });

    const contentType = upstreamRes.headers["content-type"] || "text/html";
    const contentLength = upstreamRes.headers["content-length"];
    const isDownload = upstreamRes.headers["content-disposition"] || 
                       contentType.includes("application/octet-stream") ||
                       contentType.includes("application/zip") ||
                       contentType.includes("application/pdf");

    // Set response headers
    res.setHeader("Content-Type", contentType);
    if (contentLength) res.setHeader("Content-Length", contentLength);
    if (isDownload) {
      res.setHeader("Content-Disposition", upstreamRes.headers["content-disposition"] || "attachment");
    }

    // For binary/non-text content, pipe directly
    if (!isTextContent(contentType) || isDownload) {
      upstreamRes.pipe(res);
      return;
    }

    // For text content, buffer and rewrite
    let body = "";
    upstreamRes.setEncoding("utf8");
    upstreamRes.on("data", chunk => body += chunk);
    upstreamRes.on("end", () => {
      if (isHtml(contentType)) {
        const proxyPrefix = `/api/fetch?url=`;
        body = rewriteUrls(body, finalUrl, proxyPrefix);

        // Inject a small UI for downloads that can't be proxied
        const downloadNotice = `
<div data-wayline-injected="true" style="display:none;position:fixed;top:0;left:0;right:0;background:#E8A33D;color:#1F1B24;padding:8px 16px;font-family:monospace;font-size:12px;z-index:999999;text-align:center;" id="wayline-dl-notice">
  This page contains a download. <a href="#" id="wayline-dl-link" style="color:#1F1B24;font-weight:bold;">Open in system browser</a>
</div>
<script data-wayline-injected="true">
document.addEventListener('click', function(e) {
  const a = e.target.closest('a[download], a[href$=\".pdf"], a[href$=\".zip"], a[href$=\".exe"]');
  if (a) {
    const notice = document.getElementById('wayline-dl-notice');
    const link = document.getElementById('wayline-dl-link');
    if (notice && link) {
      notice.style.display = 'block';
      link.href = a.href.replace('/api/fetch?url=', '').replace(/\?.*$/, '');
      link.onclick = function() { window.open(a.href, '_blank'); notice.style.display='none'; return false; };
    }
  }
});
</script>`;
        body = body.replace(/<\/body>/i, downloadNotice + "\n</body>");
      }

      res.send(body);
    });

  } catch (err) {
    console.error("Proxy error:", err.message);
    res.status(502).send(`
<!DOCTYPE html>
<html>
<head><title>Wayline — Load Error</title>
<style>
body { background: #1F1B24; color: #EDE7DE; font-family: 'Space Mono', monospace; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; flex-direction: column; gap: 16px; text-align: center; padding: 24px; }
h1 { color: #E8A33D; font-size: 18px; margin: 0; }
p { color: #9A8FA3; font-size: 13px; max-width: 480px; line-height: 1.6; }
a { color: #4FA9A0; text-decoration: none; border-bottom: 1px solid #4FA9A033; }
.code { background: #2A2430; padding: 12px 16px; border-radius: 6px; font-size: 11px; color: #D1585B; border: 1px solid #40384A; }
</style>
</head>
<body>
<h1>⚠ WAYPOINT UNREACHABLE</h1>
<p>The console couldn't load <strong>${decodedUrl}</strong>.</p>
<p class="code">${err.message}</p>
<p><a href="${decodedUrl}" target="_blank">Open in system browser →</a></p>
</body>
</html>
    `);
  }
});

// Serve config.json
app.get("/config.json", (req, res) => {
  res.sendFile(path.join(__dirname, "config.json"));
});

// Static files
app.use(express.static(path.join(__dirname, "public")));

// SPA fallback
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  Wayline Browser v2.0                    ║`);
  console.log(`║  http://localhost:${PORT.toString().padEnd(23)}║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
});
