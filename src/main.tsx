import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@mdxeditor/editor/style.css'
import './index.css'
import App from './App.tsx'

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    if (import.meta.env.DEV) {
      void navigator.serviceWorker.getRegistrations().then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      void caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('notes-shell-')).map((key) => caches.delete(key))))
    } else {
      void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
      // A controller swap after the page was already controlled means a new
      // service worker took over — the running bundle is now behind. The SW
      // itself uses skipWaiting+claim, so flag it and let the UI prompt.
      if (navigator.serviceWorker.controller) {
        navigator.serviceWorker.addEventListener('controllerchange', () => {
          window.dispatchEvent(new Event('notes-sw-updated'))
        })
      }
    }
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
