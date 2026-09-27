import { deleteDoc, doc, getDoc, setDoc } from 'firebase/firestore'
import { firestore } from './firebase'

// Ring phone alerts: the Pebble receiver pushes to every subscription stored
// under users/{uid}/pushSubscriptions. The VAPID public key is provisioned by
// the backend at users/{uid}/metadata/pushConfig so the app never needs the
// key at build time; key rotation propagates on the next processed recording.
export function isPushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

export type PushStatus = 'unsupported' | 'unconfigured' | 'denied' | 'enabled' | 'disabled'

export async function pushStatus(uid: string): Promise<PushStatus> {
  if (!firestore || !isPushSupported()) return 'unsupported'
  const config = await getDoc(doc(firestore, 'users', uid, 'metadata', 'pushConfig')).catch(() => undefined)
  if (typeof config?.data()?.vapidPublicKey !== 'string') return 'unconfigured'
  if (Notification.permission === 'denied') return 'denied'
  const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined)
  const subscription = await registration?.pushManager.getSubscription().catch(() => undefined)
  return subscription ? 'enabled' : 'disabled'
}

function urlBase64ToUint8Array(value: string) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  const base64 = `${value}${padding}`.replaceAll('-', '+').replaceAll('_', '/')
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
}

async function subscriptionDocId(endpoint: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

async function serviceWorkerRegistration() {
  const existing = await navigator.serviceWorker.getRegistration()
  if (existing) return existing
  await navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`)
  return navigator.serviceWorker.ready
}

export async function enablePush(uid: string): Promise<PushStatus> {
  if (!firestore || !isPushSupported()) return 'unsupported'
  const config = await getDoc(doc(firestore, 'users', uid, 'metadata', 'pushConfig')).catch(() => undefined)
  const vapidPublicKey = config?.data()?.vapidPublicKey
  if (typeof vapidPublicKey !== 'string' || !vapidPublicKey) return 'unconfigured'
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'
  const registration = await serviceWorkerRegistration()
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
  })
  await setDoc(doc(firestore, 'users', uid, 'pushSubscriptions', await subscriptionDocId(subscription.endpoint)), {
    ...subscription.toJSON(),
    updatedAt: Date.now(),
    userAgent: navigator.userAgent,
  })
  return 'enabled'
}

export async function disablePush(uid: string): Promise<PushStatus> {
  const registration = await navigator.serviceWorker.getRegistration().catch(() => undefined)
  const subscription = await registration?.pushManager.getSubscription().catch(() => undefined)
  if (!subscription) return 'disabled'
  const id = await subscriptionDocId(subscription.endpoint)
  await subscription.unsubscribe().catch(() => undefined)
  if (firestore) await deleteDoc(doc(firestore, 'users', uid, 'pushSubscriptions', id)).catch(() => undefined)
  return 'disabled'
}
