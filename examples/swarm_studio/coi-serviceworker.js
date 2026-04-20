/*
 * coi-serviceworker.js — Cross-Origin Isolation + offline cache service worker.
 *
 * Two jobs in one SW:
 *
 * 1. COOP/COEP/CORP headers — injected on every response so SharedArrayBuffer
 *    is available on GitHub Pages (which cannot set custom HTTP headers directly).
 *
 * 2. Cache-first for same-origin assets — the app shell (index.html, JS, wheels)
 *    and the bundled Pyodide runtime (pyodide-cache/*) are cached in Cache Storage
 *    on first visit.  Subsequent loads skip the network entirely — Pyodide starts
 *    instantly instead of re-downloading 20 MB every session.
 *
 * Usage: include this script in index.html BEFORE any other JS:
 *   <script src="coi-serviceworker.js"></script>
 *
 * On first load the SW is installed and the page is reloaded once.
 * All subsequent loads are served from cache with COOP/COEP headers set.
 *
 * Based on: https://github.com/gzuidhof/coi-serviceworker (MIT)
 */
(() => {
  if (typeof window === "undefined") {
    // ── Service Worker context ─────────────────────────────────────────────────

    const CACHE_NAME = "ruvon-swarm-v2";

    // Helper: inject isolation headers onto a Response
    function withIsolationHeaders(r) {
      if (!r || r.status === 0) return r;
      const headers = new Headers(r.headers);
      headers.set("Cross-Origin-Opener-Policy",   "same-origin");
      headers.set("Cross-Origin-Embedder-Policy", "require-corp");
      headers.set("Cross-Origin-Resource-Policy", "cross-origin");
      return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
    }

    self.addEventListener("install", () => {
      console.log("[COI-SW] install — skipWaiting");
      self.skipWaiting();
    });

    self.addEventListener("activate", (e) => {
      console.log("[COI-SW] activate — claiming clients");
      // Evict stale cache versions when CACHE_NAME changes
      e.waitUntil(
        caches.keys().then(keys =>
          Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => {
            console.log("[COI-SW] deleting stale cache:", k);
            return caches.delete(k);
          }))
        ).then(() => self.clients.claim())
      );
    });

    self.addEventListener("fetch", (e) => {
      if (e.request.method !== "GET") return;
      if (e.request.cache === "only-if-cached" && e.request.mode !== "same-origin") return;

      const reqUrl = new URL(e.request.url);

      // Don't proxy loopback — service worker can't reach localhost from Pages origin
      if (reqUrl.hostname === "localhost" || reqUrl.hostname === "127.0.0.1" || reqUrl.hostname === "::1") return;

      // WebSocket upgrades: fetch() can't handle them — let the browser pass them through
      if (e.request.mode === "websocket") return;

      const isSameOrigin = reqUrl.origin === self.location.origin;

      if (isSameOrigin) {
        // ── Cache-first for same-origin (app shell + pyodide-cache) ──────────
        // On cache hit: serve instantly (no network round-trip).
        // On cache miss: fetch, cache, then return — so next visit is instant.
        e.respondWith((async () => {
          const cache  = await caches.open(CACHE_NAME);
          const cached = await cache.match(e.request);
          if (cached) {
            return withIsolationHeaders(cached);
          }
          try {
            const fresh = await fetch(e.request);
            if (fresh.ok) cache.put(e.request, fresh.clone());
            return withIsolationHeaders(fresh);
          } catch (err) {
            console.warn("[COI-SW] same-origin fetch failed:", reqUrl.pathname, err?.message);
            // Must return a Response — returning undefined causes an "Uncaught (in promise)" flood
            return new Response("Service Unavailable", { status: 503, statusText: "Service Unavailable" });
          }
        })());
      } else {
        // ── Header-inject only for cross-origin (CDN fallback, PeerJS signaling) ──
        e.respondWith(
          fetch(e.request).then(withIsolationHeaders).catch(err => {
            // Must return Response.error() — returning undefined triggers "Uncaught (in promise)"
            // on every failed fetch, flooding the console.
            return Response.error();
          })
        );
      }
    });

    return;
  }

  // ── Main thread: register the SW if not already active ──────────────────────
  console.log("[COI-SW] main thread — crossOriginIsolated:", crossOriginIsolated);
  if (!crossOriginIsolated && "serviceWorker" in navigator) {
    navigator.serviceWorker.register(
      new URL("coi-serviceworker.js", location.href).pathname
    ).then((reg) => {
      console.log("[COI-SW] registered — active:", reg.active?.state,
                  "| installing:", reg.installing?.state,
                  "| waiting:", reg.waiting?.state);
      // Reload once the SW is active so COOP/COEP headers take effect
      if (!reg.active) {
        const sw = reg.installing || reg.waiting;
        if (sw) {
          sw.addEventListener("statechange", (ev) => {
            console.log("[COI-SW] statechange →", ev.target.state);
            if (ev.target.state === "activated") location.reload();
          });
        }
        reg.addEventListener("updatefound", () => {
          console.log("[COI-SW] updatefound");
          reg.installing?.addEventListener("statechange", (ev) => {
            console.log("[COI-SW] installing statechange →", ev.target.state);
            if (ev.target.state === "activated") location.reload();
          });
        });
      } else {
        console.log("[COI-SW] SW already active — reloading");
        location.reload();
      }
    }).catch(err => console.error("[COI-SW] registration failed:", err));
  }
})();
