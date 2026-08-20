/**
 * Wayline Browser — server.js
 * ---------------------------
 * Serves the static console UI (public/) and exposes a small proxy
 * endpoint (/api/fetch) that lets the console embed pages that would
 * otherwise refuse to load inside an <iframe> (X-Frame-Options / CSP
 * frame-ancestors). This is a convenience for a personal/local tool —
 * respect the target site's terms of service when using it.
 */

const express = require("express");
const https = require("https");
const http = require("http");
const { URL } = require("url");
const fs = require("fs");
const path = require("path");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const PORT = process.env.PORT || config.port || 4173;

const app = express();
app.use(express.static(path.join(__dirname, "public")));
app.get("/config.json", (req, res) => res.json(config));

const MAX_REDIRECTS = 5;

function fetchUrl(targetUrl, redirectsLeft, cb) {
  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch (err) {
    return cb(new Error("Invalid URL"));
  }

  const client = parsed.protocol === "http:" ? http : https;

  const req = client.get(
    parsed,
    {
      headers: {
        "User-Agent": (config.proxy && config.proxy.userAgent) || "Mozilla/5.0",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
      timeout: 15000,
    },
    (res) => {
      // Follow redirects manually so we can keep rewriting the base URL.
      if (
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location &&
        redirectsLeft > 0
      ) {
        const nextUrl = new URL(res.headers.location, parsed).toString();
        res.resume();
        return fetchUrl(nextUrl, redirectsLeft - 1, cb);
      }

      let chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        cb(null, {
          statusCode: res.statusCode,
          contentType: res.headers["content-type"] || "text/html",
          body: Buffer.concat(chunks),
          finalUrl: parsed.toString(),
        });
      });
    }
  );

  req.on("timeout", () => req.destroy(new Error("Upstream timed out")));
  req.on("error", (err) => cb(err));
}

app.get("/api/fetch", (req, res) => {
  if (!config.proxy || !config.proxy.enabled) {
    return res.status(403).send("Embed proxy is disabled in config.json.");
  }

  const target = req.query.url;
  if (!target) return res.status(400).send("Missing ?url=");

  let normalized = target;
  if (!/^https?:\/\//i.test(normalized)) normalized = "https://" + normalized;

  fetchUrl(normalized, MAX_REDIRECTS, (err, result) => {
    if (err) {
      return res
        .status(502)
        .send(
          `<html><body style="font-family:monospace;background:#1F1B24;color:#EDE7DE;padding:2rem;">` +
            `Wayline could not reach that page.<br>${escapeHtml(err.message)}</body></html>`
        );
    }

    const isHtml = /text\/html/i.test(result.contentType);

    if (!isHtml) {
      res.setHeader("Content-Type", result.contentType);
      return res.send(result.body);
    }

    let html = result.body.toString("utf8");

    // Inject a <base> tag so relative links/assets resolve against the
    // real origin, and drop the two most common framing blockers found
    // in inline meta tags.
    const baseTag = `<base href="${result.finalUrl}">`;
    if (/<head[^>]*>/i.test(html)) {
      html = html.replace(/<head[^>]*>/i, (m) => `${m}\n${baseTag}`);
    } else {
      html = baseTag + html;
    }

    html = html.replace(
      /<meta[^>]+http-equiv=["']?X-Frame-Options["']?[^>]*>/gi,
      ""
    );

    res.removeHeader("X-Frame-Options");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // Deliberately do not forward the upstream CSP header, since it's
    // frequently what blocks framing in the first place.
    res.send(html);
  });
});

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[c]));
}

app.listen(PORT, () => {
  console.log(`\n  ${config.appName} is running → http://localhost:${PORT}\n`);
});
