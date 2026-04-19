/*
 * coi-serviceworker.js — Cross-Origin Isolation service worker.
 *
 * Adds Cross-Origin-Opener-Policy: same-origin and
 * Cross-Origin-Embedder-Policy: require-corp headers to every response
 * so SharedArrayBuffer is available on GitHub Pages (which cannot set
 * custom HTTP headers directly).
 *
 * Usage: include this script in index.html BEFORE any other JS:
 *   <script src="coi-serviceworker.js"></script>
 *
 * On first load the SW is installed and the page is reloaded once.
 * All subsequent loads are served directly by the SW with COOP/COEP set.
 *
 * Based on: https://github.com/gzuidhof/coi-serviceworker (MIT)
 */
(() => {
  if (typeof window === "undefined") {
    // Running inside the service worker itself
    self.addEventListener("install",  () => {
      console.log("[COI-SW] install — skipWaiting");
      self.skipWaiting();
    });
    self.addEventListener("activate", (e) => {
      console.log("[COI-SW] activate — claiming clients");
      e.waitUntil(self.clients.claim());
    });
    self.addEventListener("fetch", (e) => {
      if (e.request.cache === "only-if-cached" && e.request.mode !== "same-origin") return;
      // Don't attempt to proxy localhost/loopback requests — they can't be reached
      // from a service worker running on GitHub Pages (or any remote origin).
      const reqUrl = new URL(e.request.url);
      if (reqUrl.hostname === "localhost" || reqUrl.hostname === "127.0.0.1" || reqUrl.hostname === "::1") return;
      // fetch() cannot handle WebSocket upgrade requests — let the browser handle them natively
      if (e.request.mode === "websocket") return;
      e.respondWith(
        fetch(e.request).then((r) => {
          if (r.status === 0) return r;
          const headers = new Headers(r.headers);
          headers.set("Cross-Origin-Opener-Policy",   "same-origin");
          headers.set("Cross-Origin-Embedder-Policy", "require-corp");
          headers.set("Cross-Origin-Resource-Policy", "cross-origin");
          console.log("[COI-SW] injected COOP/COEP on", reqUrl.pathname);
          return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
        }).catch(err => {
          // Log but don't re-throw as Response.error() — that floods the console
          // with "FetchEvent resulted in a network error response" for every failure.
          console.warn("[COI-SW] fetch failed for", reqUrl.href, err?.message);
        })
      );
    });
    return;
  }

  // Main thread: register the SW if not already active
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
        // Handle both: SW already installing (reg.installing set) and future installs
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
