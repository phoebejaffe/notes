import { initializeApp, getApps } from 'firebase/app'
import { getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithCredential, signInWithPopup, signOut, type User } from 'firebase/auth'
import { getFirestore } from 'firebase/firestore'

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
}

export const firebaseConfigured = Object.values(config).every(Boolean)
const app = firebaseConfigured ? (getApps()[0] ?? initializeApp(config)) : undefined
export const auth = app ? getAuth(app) : undefined
export const firestore = app ? getFirestore(app) : undefined

export function watchAuth(callback: (user: User | null) => void) {
  if (!auth) return () => undefined
  return onAuthStateChanged(auth, callback)
}

function isTauriEnvironment() {
  return '__TAURI_INTERNALS__' in window
}

function toBase64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function signInWithGoogleInDesktop() {
  if (!auth) throw new Error('Firebase is not configured')
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
  const clientSecret = import.meta.env.VITE_GOOGLE_CLIENT_SECRET
  if (!clientId) throw new Error('Set VITE_GOOGLE_CLIENT_ID to enable Google sign-in in the Mac app')
  if (!clientSecret) throw new Error('Set VITE_GOOGLE_CLIENT_SECRET to enable Google sign-in in the Mac app')

  const { start, cancel, onUrl } = await import('@fabianlars/tauri-plugin-oauth')
  const { open } = await import('@tauri-apps/plugin-shell')
  const port = await start()
  const redirectUri = `http://127.0.0.1:${port}`
  const state = crypto.randomUUID()
  const verifierBytes = new Uint8Array(32)
  crypto.getRandomValues(verifierBytes)
  const codeVerifier = toBase64Url(verifierBytes)
  const challenge = toBase64Url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier))))
  let unlisten: (() => void) | undefined
  const callback = new Promise<string>((resolve, reject) => {
    onUrl((url) => {
      try {
        const parsed = new URL(url)
        if (parsed.searchParams.get('state') !== state) throw new Error('Invalid Google sign-in state')
        if (parsed.searchParams.get('error')) throw new Error(parsed.searchParams.get('error_description') || parsed.searchParams.get('error') || 'Google authorization failed')
        resolve(url)
      } catch (error) {
        reject(error)
      }
    }).then((cleanup) => { unlisten = cleanup }).catch(reject)
  })
  try {
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account' })
    await open(`https://accounts.google.com/o/oauth2/v2/auth?${params}`)
    const result = new URL(await callback)
    const code = result.searchParams.get('code')
    if (!code) throw new Error('Google did not return an authorization code')
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: codeVerifier }) })
    const tokenPayload = await tokenResponse.json() as { access_token?: string; error_description?: string }
    if (!tokenResponse.ok || !tokenPayload.access_token) throw new Error(tokenPayload.error_description || 'Google token exchange failed')
    return signInWithCredential(auth, GoogleAuthProvider.credential(null, tokenPayload.access_token))
  } finally {
    unlisten?.()
    await cancel(port).catch(() => undefined)
  }
}

export async function signInWithGoogle() {
  if (!auth) throw new Error('Firebase is not configured')
  return isTauriEnvironment() ? signInWithGoogleInDesktop() : signInWithPopup(auth, new GoogleAuthProvider())
}

export async function signOutOfGoogle() {
  if (auth) await signOut(auth)
}
