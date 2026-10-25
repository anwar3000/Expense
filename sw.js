// Minimal service worker so the app can be installed on phones. Always uses the network (data is live in Firebase).
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
