// sw.js
//
// IMPORTANT: bump CACHE_VERSION any time ANY cached asset changes
// (HTML, CSS, JS, icons). This is the entire cache-busting mechanism —
// the old cache is deleted in `activate` once a new version installs.
const CACHE_VERSION = 'v2';
const CACHE_NAME = `cardprint-pro-${CACHE_VERSION}`;

// Precached at install time. Paths are relative to this file's location,
// which keeps this working correctly under a GitHub Pages project subpath
// (e.g. https://user.github.io/repo/) as well as a root deployment.
const APP_SHELL = [
    './',
    './index.html',
    './css/style.css',
    './js/app.js',
    './js/smartCardFit.js',
    './js/imageEngine.js',
    './js/pdfEngine.js',
    './js/printEngine.js',
    './manifest.json',
    './assets/icon-32.png',
    './assets/icon-192.png',
    './assets/icon-512.png'
];

// Third-party CDN assets required for the app to function fully offline.
// Cached separately from APP_SHELL so a CDN hiccup never blocks local
// asset caching (see install handler below).
const CDN_ASSETS = [
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.4.120/pdf.worker.min.js'
];

const NAVIGATION_FALLBACK = './index.html';

self.addEventListener('install', (event) => {
    event.waitUntil(
        (async () => {
            const cache = await caches.open(CACHE_NAME);

            // Cache each asset independently instead of cache.addAll(), which
            // is all-or-nothing: a single failed request (e.g. a transient
            // network blip on the CDN worker script) would otherwise abort
            // the ENTIRE install and leave the app with no offline cache at
            // all. Promise.allSettled lets local assets succeed even if a
            // CDN asset temporarily fails; the CDN fetch will simply be
            // retried opportunistically later via the runtime cache in the
            // fetch handler.
            const allAssets = [...APP_SHELL, ...CDN_ASSETS];
            await Promise.allSettled(
                allAssets.map(async (url) => {
                    try {
                        const request = new Request(url, { cache: 'reload' });
                        const response = await fetch(request);
                        if (response.ok || response.type === 'opaque') {
                            await cache.put(url, response);
                        }
                    } catch (err) {
                        // Swallow individual failures — see comment above.
                    }
                })
            );

            // Activate the new service worker immediately rather than
            // waiting for all tabs to close. Combined with clients.claim()
            // in `activate` and the controllerchange reload in app.js, this
            // is the app's automatic update strategy.
            await self.skipWaiting();
        })()
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            const cacheNames = await caches.keys();
            await Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            );
            await self.clients.claim();
        })()
    );
});

self.addEventListener('fetch', (event) => {
    const { request } = event;

    // Only intercept GET requests over http(s) — POST bodies, chrome-extension://
    // requests, and other schemes must pass straight through untouched.
    if (request.method !== 'GET') return;
    if (!request.url.startsWith('http://') && !request.url.startsWith('https://')) return;

    // Navigation requests (address bar entry, link click, reload) get a
    // network-first strategy with an offline fallback to the cached app
    // shell, so the app still boots when there's no connection at all —
    // this is what makes the PWA genuinely "fully offline" rather than
    // just caching a few static files.
    if (request.mode === 'navigate') {
        event.respondWith(
            (async () => {
                try {
                    const networkResponse = await fetch(request);
                    const cache = await caches.open(CACHE_NAME);
                    cache.put(NAVIGATION_FALLBACK, networkResponse.clone());
                    return networkResponse;
                } catch (err) {
                    const cache = await caches.open(CACHE_NAME);
                    const cached = await cache.match(NAVIGATION_FALLBACK);
                    return cached || Response.error();
                }
            })()
        );
        return;
    }

    // Everything else (CSS/JS/icons/CDN scripts): cache-first for instant,
    // fully-offline loads, with a stale-while-revalidate style background
    // refresh so the cache slowly self-heals and stays current when online,
    // without ever blocking the response on network latency.
    event.respondWith(
        (async () => {
            const cache = await caches.open(CACHE_NAME);
            const cachedResponse = await cache.match(request);

            const networkFetch = fetch(request)
                .then((networkResponse) => {
                    if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
                        cache.put(request, networkResponse.clone());
                    }
                    return networkResponse;
                })
                .catch(() => null);

            if (cachedResponse) {
                // Don't await the network refresh — return the cached asset
                // immediately for speed, update the cache silently in the
                // background for next time.
                event.waitUntil(networkFetch);
                return cachedResponse;
            }

            const networkResponse = await networkFetch;
            if (networkResponse) return networkResponse;

            // Nothing cached and network unavailable: fail gracefully rather
            // than throwing an unhandled rejection inside respondWith.
            return new Response('Offline and no cached version available.', {
                status: 503,
                statusText: 'Service Unavailable',
                headers: { 'Content-Type': 'text/plain' }
            });
        })()
    );
});
