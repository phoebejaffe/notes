const CACHE_NAME = 'notes-shell-v2'
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('notes-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key)))))
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return
  const requestUrl = new URL(event.request.url)
  if (requestUrl.origin !== self.location.origin) return

  const isDocument = event.request.mode === 'navigate' || event.request.destination === 'document' || requestUrl.pathname.endsWith('.html')
  if (isDocument) {
    event.respondWith(fetch(event.request, { cache: 'no-store' }).then((response) => {
      if (response.ok) {
        const copy = response.clone()
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy))
      }
      return response
    }).catch(() => caches.match(event.request).then((cached) => cached ?? caches.match('/index.html'))))
    return
  }

  const isFingerprintAsset = requestUrl.pathname.startsWith('/assets/')
  if (isFingerprintAsset) {
    event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request).then((response) => {
      if (response.ok) {
        const copy = response.clone()
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy))
      }
      return response
    })))
  }
})
