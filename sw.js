// Service worker: keeps a copy of the app on the device so it opens and runs offline.
const CACHE = 'cybersafe-ng-v4';
const SHELL = [
  './', 'index.html', 'css/styles.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'data/seed.json', 'js/app.js', 'js/db.js', 'js/vendor/sql-wasm.js', 'js/vendor/sql-wasm.wasm',
  'js/services/auth.js', 'js/services/content.js', 'js/services/crypto.js', 'js/services/errors.js',
  'js/services/progress.js', 'js/services/quiz.js', 'js/services/teacher.js', 'js/services/admin.js',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first so updates arrive when online; the cached copy is used when offline.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
