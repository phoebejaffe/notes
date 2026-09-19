import { collection, deleteDoc, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, runTransaction, setDoc, type DocumentData } from 'firebase/firestore'
import { firestore } from './firebase'
import { decryptDailyDocument, encryptDailyDocument, type EncryptedDailyDocument } from './encryptedSync'
import { createKeyBundle, recoverDataKey, type KeyBundle } from './crypto'
import { mergeMarkdown } from './markdownMerge'
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

export interface SyncConflict {
  day: string
  local: DailyDocument
  remote: DailyDocument
  base?: DailyDocument['syncBase']
}

export type EncryptedDocumentUploadResult =
  | { status: 'written'; document: DailyDocument }
  | { status: 'conflict'; conflict: SyncConflict }

export interface EncryptedDocumentUploadOptions {
  strategy?: 'merge' | 'replace'
}

function withSyncBase(document: DailyDocument): DailyDocument {
  return { ...document, syncBase: { markdown: document.markdown, updatedAt: document.updatedAt } }
}

function conflictResult(day: string, local: DailyDocument, remote: DailyDocument): EncryptedDocumentUploadResult {
  return { status: 'conflict', conflict: { day, local, remote, base: local.syncBase } }
}

export type DocumentUploadDecision =
  | { action: 'write'; markdown: string }
  | { action: 'adopt' }
  | { action: 'conflict' }

export function resolveDocumentUpload(
  document: DailyDocument,
  remote: DailyDocument | undefined,
  strategy: 'merge' | 'replace' = 'merge',
): DocumentUploadDecision {
  if (!remote || remote.markdown === document.markdown) return remote ? { action: 'adopt' } : { action: 'write', markdown: document.markdown }

  const base = document.syncBase
  if (strategy === 'replace') {
    if (!base || remote.markdown !== base.markdown) return { action: 'conflict' }
    return { action: 'write', markdown: document.markdown }
  }

  if (!base) return { action: 'conflict' }
  if (remote.markdown === base.markdown) return { action: 'write', markdown: document.markdown }

  const merged = mergeMarkdown(base.markdown, document.markdown, remote.markdown)
  if (merged.status === 'conflict') return { action: 'conflict' }
  return merged.markdown === remote.markdown ? { action: 'adopt' } : { action: 'write', markdown: merged.markdown }
}

export async function uploadEncryptedDocument(
  uid: string,
  document: DailyDocument,
  key: CryptoKey,
  options: EncryptedDocumentUploadOptions = {},
): Promise<EncryptedDocumentUploadResult> {
  if (!firestore) throw new Error('Firebase is not configured')
  const documentRef = doc(documentsPath(uid), document.day)
  return runTransaction(firestore, async (transaction) => {
    const snapshot = await transaction.get(documentRef)
    const remote = snapshot.exists()
      ? await decryptDailyDocument(asEncryptedDocument(snapshot.data()), key)
      : undefined
    const writeDocument = async (markdown: string) => {
      const next = { day: document.day, markdown, updatedAt: Date.now() }
      transaction.set(documentRef, await encryptDailyDocument(next, key))
      return { status: 'written' as const, document: withSyncBase(next) }
    }

    const decision = resolveDocumentUpload(document, remote, options.strategy)
    if (decision.action === 'adopt') return { status: 'written', document: withSyncBase(remote!) }
    if (decision.action === 'conflict') return conflictResult(document.day, document, remote!)
    return writeDocument(decision.markdown)
  })
}

function asEncryptedDocument(value: DocumentData) {
  return value as EncryptedDailyDocument
}

export async function syncDocuments(uid: string, localDocuments: DailyDocument[], key: CryptoKey) {
  if (!firestore) throw new Error('Firebase is not configured')
  const remote = await getDocs(query(documentsPath(uid), orderBy('updatedAt', 'desc'), limit(1000)))
  const localByDay = new Map(localDocuments.map((document) => [document.day, document]))
  const remoteByDay = new Map<string, DailyDocument>()
  const merged = new Map<string, DailyDocument>()
  const conflicts: SyncConflict[] = []
  const uploads: { local: DailyDocument; remote?: DailyDocument }[] = []

  for (const snapshot of remote.docs) {
    const remoteDocument = await decryptDailyDocument(asEncryptedDocument(snapshot.data()), key)
    remoteByDay.set(remoteDocument.day, remoteDocument)
    const localDocument = localByDay.get(remoteDocument.day)
    if (!localDocument || localDocument.markdown === remoteDocument.markdown || localDocument.markdown === localDocument.syncBase?.markdown) {
      merged.set(remoteDocument.day, withSyncBase(remoteDocument))
      continue
    }
    if (!localDocument.syncBase) {
      conflicts.push({ day: remoteDocument.day, local: localDocument, remote: remoteDocument })
      merged.set(localDocument.day, localDocument)
      continue
    }
    uploads.push({ local: localDocument, remote: remoteDocument })
  }

  for (const document of localDocuments) {
    if (!remoteByDay.has(document.day)) uploads.push({ local: document })
  }

  const uploadResults = await Promise.all(uploads.map(({ local }) => uploadEncryptedDocument(uid, local, key)))
  uploadResults.forEach((result, index) => {
    const { local, remote } = uploads[index]
    if (result.status === 'written') {
      merged.set(result.document.day, result.document)
      return
    }
    conflicts.push(result.conflict)
    merged.set(local.day, local)
    if (remote) remoteByDay.set(remote.day, remote)
  })

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
