const CACHE_NAME = 'notes-shell-v3'
const BASE_PATH = new URL('.', self.location.href).pathname
const APP_SHELL = [BASE_PATH, `${BASE_PATH}index.html`, `${BASE_PATH}manifest.webmanifest`]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)))
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('notes-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key)))))
  self.clients.claim()
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = {}
  }
  event.waitUntil(self.registration.showNotification(data.title || 'Noteses', {
    body: data.body || '',
    icon: `${BASE_PATH}favicon.svg`,
    badge: `${BASE_PATH}favicon.svg`,
    tag: data.tag || 'noteses-ring',
    renotify: true,
    data: { url: data.url || BASE_PATH },
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url || BASE_PATH
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const client = list.find((item) => item.url.includes(BASE_PATH)) ?? list[0]
    if (client) return client.focus()
    return clients.openWindow(target)
  }))
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
    }).catch(() => caches.match(event.request).then((cached) => cached ?? caches.match(`${BASE_PATH}index.html`))))
    return
  }

  const isFingerprintAsset = requestUrl.pathname.startsWith(`${BASE_PATH}assets/`)
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
