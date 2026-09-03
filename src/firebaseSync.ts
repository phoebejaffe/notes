import { collection, deleteDoc, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, setDoc, type DocumentData } from 'firebase/firestore'
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

export async function createRemoteKeyBundle(uid: string, recoveryPhrase?: string) {
  if (!firestore) throw new Error('Firebase is not configured')
  const created = await createKeyBundle(recoveryPhrase)
  await setDoc(keyBundlePath(uid), created.bundle)
  return { ...created, key: await recoverDataKey(created.recoveryKey, created.bundle) }
}

export async function uploadEncryptedDocument(uid: string, document: DailyDocument, key: CryptoKey) {
  if (!firestore) throw new Error('Firebase is not configured')
  const encrypted = await encryptDailyDocument(document, key)
  await setDoc(doc(documentsPath(uid), document.day), encrypted)
}

export interface SyncConflict {
  day: string
  local: DailyDocument
  remote: DailyDocument
}

function asEncryptedDocument(value: DocumentData) {
  return value as EncryptedDailyDocument
}

export async function syncDocuments(uid: string, localDocuments: DailyDocument[], key: CryptoKey) {
  if (!firestore) throw new Error('Firebase is not configured')
  const remote = await getDocs(query(documentsPath(uid), orderBy('updatedAt', 'desc'), limit(1000)))
  const localByDay = new Map(localDocuments.map((document) => [document.day, document]))
  const merged = new Map(localDocuments.map((document) => [document.day, document]))
  const conflicts: SyncConflict[] = []
  const uploads: Promise<void>[] = []
  for (const snapshot of remote.docs) {
    const remoteDocument = await decryptDailyDocument(asEncryptedDocument(snapshot.data()), key)
    const localDocument = localByDay.get(remoteDocument.day)
    if (localDocument && localDocument.markdown && remoteDocument.markdown && localDocument.markdown !== remoteDocument.markdown) {
      conflicts.push({ day: remoteDocument.day, local: localDocument, remote: remoteDocument })
      continue
    }
    if (!localDocument || remoteDocument.updatedAt > localDocument.updatedAt) merged.set(remoteDocument.day, remoteDocument)
    if (localDocument && localDocument.updatedAt > remoteDocument.updatedAt) uploads.push(uploadEncryptedDocument(uid, localDocument, key))
  }
  for (const document of merged.values()) {
    if (!remote.docs.some((snapshot) => snapshot.id === document.day) && !conflicts.some((conflict) => conflict.day === document.day)) uploads.push(uploadEncryptedDocument(uid, document, key))
  }
  await Promise.all(uploads)
  return { documents: [...merged.values()], conflicts }
}

export function watchRemoteDocuments(uid: string, key: CryptoKey, onDocuments: (documents: DailyDocument[]) => void, onError: (error: Error) => void) {
  if (!firestore) return () => undefined
  return onSnapshot(query(documentsPath(uid), orderBy('updatedAt', 'desc'), limit(1000)), (snapshot) => {
    void Promise.all(snapshot.docs.map(async (snapshot) => decryptDailyDocument(asEncryptedDocument(snapshot.data()), key))).then(onDocuments).catch((error: unknown) => onError(error instanceof Error ? error : new Error(String(error))))
  }, onError)
}

export async function recoverRemoteDataKey(uid: string, recoveryPhrase: string) {
  const bundle = await loadRemoteKeyBundle(uid)
  if (!bundle) return undefined
  return recoverDataKey(recoveryPhrase, bundle)
}

export async function deleteRemoteUserData(uid: string) {
  if (!firestore) throw new Error('Firebase is not configured')
  const documents = await getDocs(documentsPath(uid))
  await Promise.all(documents.docs.map((snapshot) => deleteDoc(snapshot.ref)))
  await deleteDoc(keyBundlePath(uid))
}
