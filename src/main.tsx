import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    if (import.meta.env.DEV) {
      void navigator.serviceWorker.getRegistrations().then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      void caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('notes-shell-')).map((key) => caches.delete(key))))
    } else {
      void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
    }
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
