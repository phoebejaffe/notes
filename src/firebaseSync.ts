import { collection, doc, getDoc, getDocs, limit, orderBy, query, setDoc, type DocumentData } from 'firebase/firestore'
import { firestore } from './firebase'
import { decryptDailyDocument, encryptDailyDocument, type EncryptedDailyDocument } from './encryptedSync'
import { createKeyBundle, recoverDataKey, type KeyBundle } from './crypto'
import type { DailyDocument } from './storage'

const keyBundlePath = (uid: string) => doc(firestore!, 'users', uid, 'metadata', 'keyBundle')
const documentsPath = (uid: string) => collection(firestore!, 'users', uid, 'documents')

export async function loadRemoteKeyBundle(uid: string) {
  if (!firestore) return undefined
  const snapshot = await getDoc(keyBundlePath(uid))
  return snapshot.exists() ? snapshot.data() as KeyBundle : undefined
}

export async function createRemoteKeyBundle(uid: string) {
  if (!firestore) throw new Error('Firebase is not configured')
  const created = await createKeyBundle()
  await setDoc(keyBundlePath(uid), created.bundle)
  return { ...created, key: await recoverDataKey(created.recoveryKey, created.bundle) }
}

export async function uploadEncryptedDocument(uid: string, document: DailyDocument, key: CryptoKey) {
  if (!firestore) throw new Error('Firebase is not configured')
  const encrypted = await encryptDailyDocument(document, key)
  await setDoc(doc(documentsPath(uid), document.day), encrypted)
}

function asEncryptedDocument(value: DocumentData) {
  return value as EncryptedDailyDocument
}

export async function syncDocuments(uid: string, localDocuments: DailyDocument[], key: CryptoKey) {
  if (!firestore) throw new Error('Firebase is not configured')
  const remote = await getDocs(query(documentsPath(uid), orderBy('updatedAt', 'desc'), limit(1000)))
  const merged = new Map(localDocuments.map((document) => [document.day, document]))
  const uploads: Promise<void>[] = []
  for (const snapshot of remote.docs) {
    const encrypted = asEncryptedDocument(snapshot.data())
    const remoteDocument = await decryptDailyDocument(encrypted, key)
    const localDocument = merged.get(remoteDocument.day)
    if (!localDocument || remoteDocument.updatedAt > localDocument.updatedAt) merged.set(remoteDocument.day, remoteDocument)
    if (localDocument && localDocument.updatedAt > remoteDocument.updatedAt) uploads.push(uploadEncryptedDocument(uid, localDocument, key))
  }
  for (const document of merged.values()) {
    if (!remote.docs.some((snapshot) => snapshot.id === document.day)) uploads.push(uploadEncryptedDocument(uid, document, key))
  }
  await Promise.all(uploads)
  return [...merged.values()]
}

export async function recoverRemoteDataKey(uid: string, recoveryPhrase: string) {
  const bundle = await loadRemoteKeyBundle(uid)
  if (!bundle) return undefined
  return recoverDataKey(recoveryPhrase, bundle)
}
