// Service worker : l'appli fonctionne hors connexion avec les dernières données reçues.
// Pense à changer VERSION quand tu modifies les fichiers du site.
const VERSION = "op-v7";
const SHELL = [
  "./", "index.html", "style.css", "config.js", "js/app.js", "js/planner.js",
  "i18n.json", "rides_meta.json", "manifest.webmanifest",
  "icons/icon.svg", "icons/icon-180.png", "icons/icon-192.png", "icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isData = url.pathname.endsWith(".json") && (url.origin !== location.origin || url.pathname.includes("/data/"));

  if (isData) {
    // Données : réseau d'abord, copie en cache pour le mode hors connexion
    e.respondWith(
      fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(url.origin + url.pathname, copy));
        }
        return res;
      }).catch(() => caches.match(url.origin + url.pathname).then((r) => r || Response.error())));
    return;
  }

  if (url.origin !== location.origin) return;

  // Fichiers du site : cache d'abord, mise à jour en arrière-plan
  e.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const net = fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || net;
    }));
});
