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
    self.addEventListener("install",  () => self.skipWaiting());
    self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
    self.addEventListener("fetch", (e) => {
      if (e.request.cache === "only-if-cached" && e.request.mode !== "same-origin") return;
      // Don't attempt to proxy localhost/loopback requests — they can't be reached
      // from a service worker running on GitHub Pages (or any remote origin).
      const reqUrl = new URL(e.request.url);
      if (reqUrl.hostname === "localhost" || reqUrl.hostname === "127.0.0.1" || reqUrl.hostname === "::1") return;
      e.respondWith(
        fetch(e.request).then((r) => {
          if (r.status === 0) return r;
          const headers = new Headers(r.headers);
          headers.set("Cross-Origin-Opener-Policy",   "same-origin");
          headers.set("Cross-Origin-Embedder-Policy", "require-corp");
          headers.set("Cross-Origin-Resource-Policy", "cross-origin");
          return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
        })
      );
    });
    return;
  }

  // Main thread: register the SW if not already active
  if (!crossOriginIsolated && "serviceWorker" in navigator) {
    navigator.serviceWorker.register(
      new URL("coi-serviceworker.js", location.href).pathname
    ).then((reg) => {
      // Reload once the SW is active so COOP/COEP headers take effect
      if (!reg.active) {
        reg.addEventListener("updatefound", () => {
          reg.installing?.addEventListener("statechange", (ev) => {
            if (ev.target.state === "activated") location.reload();
          });
        });
      } else {
        location.reload();
      }
    }).catch(console.error);
  }
})();
