// Network-only service worker: it exists so the app can be installed to the home screen.
// (Web Push handling will be added here in P3.)
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
