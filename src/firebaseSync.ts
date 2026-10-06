import { collection, deleteDoc, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, runTransaction, setDoc, type DocumentData } from 'firebase/firestore'
import { firestore } from './firebase'
import { decryptDailyDocument, decryptNamedDocument, encryptDailyDocument, type EncryptedDailyDocument, type EncryptedNamedDocument } from './encryptedSync'
import { createKeyBundle, recoverDataKey, type EncryptedEnvelope, type KeyBundle } from './crypto'
import { mergeMarkdown } from './markdownMerge'
import type { DailyDocument, DocumentSyncBase, NamedDocument } from './storage'

const keyBundlePath = (uid: string) => doc(firestore!, 'users', uid, 'metadata', 'keyBundle')
const documentsPath = (uid: string) => collection(firestore!, 'users', uid, 'documents')
const namedDocumentsPath = (uid: string) => collection(firestore!, 'users', uid, 'namedDocuments')

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
  // Document key: a `YYYY-MM-DD` day for daily documents, a note id for named
  // documents (family === 'named'). Named conflicts carry the note title for
  // display; local/remote are reduced to the shared {day: key, markdown,
  // updatedAt, syncBase} shape since conflict resolution only merges markdown.
  day: string
  family?: 'named'
  title?: string
  local: DailyDocument
  remote: DailyDocument
  base?: DailyDocument['syncBase']
}

export type EncryptedDocumentUploadResult =
  | { status: 'written'; document: DailyDocument }
  | { status: 'conflict'; conflict: SyncConflict }

export interface EncryptedDocumentUploadOptions {
  strategy?: 'merge' | 'replace'
  // Called synchronously inside the transaction with the id stamped into the
  // encrypted payload, so the watcher can recognize this write's snapshot —
  // which may land before the transaction resolves — as our own echo even when
  // the committed markdown is a merge result that differs from what we sent.
  onWriteId?: (writeId: string) => void
}

function withSyncBase(document: DailyDocument): DailyDocument {
  return { ...document, syncBase: { markdown: document.markdown, updatedAt: document.updatedAt } }
}

function conflictResult(day: string, local: DailyDocument, remote: DailyDocument): EncryptedDocumentUploadResult {
  return { status: 'conflict', conflict: { day, local, remote, base: local.syncBase } }
}

// The structural minimum the merge logic needs — DailyDocument and
// NamedDocument both satisfy it.
export interface SyncableDocument {
  markdown: string
  updatedAt: number
  syncBase?: DocumentSyncBase
}

export type DocumentUploadDecision =
  | { action: 'write'; markdown: string }
  | { action: 'adopt' }
  | { action: 'conflict' }

// Snapshot handlers run after an async decrypt, so they can observe commits
// out of order — a superseded version must never regress the merge base or
// the dedupe record. Two consecutive commits can share a Date.now() stamp,
// so known own writes also compare their registration sequence.
export function isStaleRemoteDocument(
  remote: { updatedAt: number; writeId?: string },
  latestRemote: { updatedAt: number; writeId?: string } | undefined,
  ownWriteSeq?: ReadonlyMap<string, number>,
): boolean {
  if (!latestRemote) return false
  if (remote.updatedAt !== latestRemote.updatedAt) return remote.updatedAt < latestRemote.updatedAt
  if (!remote.writeId || !latestRemote.writeId || remote.writeId === latestRemote.writeId) return false
  const remoteSeq = ownWriteSeq?.get(remote.writeId)
  const latestSeq = ownWriteSeq?.get(latestRemote.writeId)
  return remoteSeq !== undefined && latestSeq !== undefined && remoteSeq < latestSeq
}

export function resolveDocumentUpload(
  document: SyncableDocument,
  remote: SyncableDocument | undefined,
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
  const writeId = crypto.randomUUID()
  return runTransaction(firestore, async (transaction) => {
    const snapshot = await transaction.get(documentRef)
    // An undecryptable remote record is treated as absent — the local write
    // then self-heals a poisoned document instead of failing forever.
    const remote = snapshot.exists()
      ? await decryptDailyDocument(asEncryptedDocument(snapshot.data()), key).catch(() => undefined)
      : undefined
    const writeDocument = async (markdown: string) => {
      options.onWriteId?.(writeId)
      const next = { day: document.day, markdown, updatedAt: Date.now(), writeId }
      transaction.set(documentRef, await encryptDailyDocument(next, key, writeId))
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

export async function syncDocuments(uid: string, localDocuments: DailyDocument[], key: CryptoKey, options: EncryptedDocumentUploadOptions = {}) {
  if (!firestore) throw new Error('Firebase is not configured')
  const remote = await getDocs(query(documentsPath(uid), orderBy('updatedAt', 'desc'), limit(1000)))
  const localByDay = new Map(localDocuments.map((document) => [document.day, document]))
  const remoteByDay = new Map<string, DailyDocument>()
  const merged = new Map<string, DailyDocument>()
  const conflicts: SyncConflict[] = []
  const uploads: { local: DailyDocument; remote?: DailyDocument }[] = []

  for (const snapshot of remote.docs) {
    const remoteDocument = await decryptDailyDocument(asEncryptedDocument(snapshot.data()), key).catch(() => undefined)
    if (!remoteDocument) continue
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

  const uploadResults = await Promise.all(uploads.map(({ local }) => uploadEncryptedDocument(uid, local, key, options)))
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

// Every snapshot re-delivers the whole collection, so memoize decryption on
// the envelope: identical {iv, ciphertext} provably decrypts to the same
// document, and most docs are unchanged between snapshots. A document that
// fails to decrypt resolves to undefined — one bad record must not sink the
// whole collection.
function makeDecryptCache<Encrypted extends { payload: EncryptedEnvelope }, Decrypted>(
  decrypt: (document: Encrypted, key: CryptoKey) => Promise<Decrypted>,
  key: CryptoKey,
) {
  const cache = new Map<string, { iv: string; ciphertext: string; document: Decrypted }>()
  return async (documents: { id: string; value: Encrypted }[]) => {
    const decrypted = await Promise.all(documents.map(async ({ id, value }) => {
      try {
        const { iv, ciphertext } = value.payload
        const cached = cache.get(id)
        if (cached && cached.iv === iv && cached.ciphertext === ciphertext) return cached.document
        const document = await decrypt(value, key)
        cache.set(id, { iv, ciphertext, document })
        return document
      } catch {
        return undefined
      }
    }))
    const seen = new Set(documents.map((document) => document.id))
    for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id)
    return decrypted
  }
}

export function watchRemoteDocuments(uid: string, key: CryptoKey, onDocuments: (documents: DailyDocument[]) => void, onError: (error: Error) => void) {
  if (!firestore) return () => undefined
  const decryptSnapshot = makeDecryptCache(decryptDailyDocument, key)
  return onSnapshot(query(documentsPath(uid), orderBy('updatedAt', 'desc'), limit(1000)), (snapshot) => {
    void decryptSnapshot(snapshot.docs.map((snapshot) => ({ id: snapshot.id, value: asEncryptedDocument(snapshot.data()) }))).then((documents) => onDocuments(documents.filter((document): document is DailyDocument => Boolean(document)))).catch((error: unknown) => onError(error instanceof Error ? error : new Error(String(error))))
  }, onError)
}

// --- Named documents -------------------------------------------------------

export type NamedDocumentUploadResult =
  | { status: 'written'; document: NamedDocument }
  | { status: 'conflict'; conflict: SyncConflict }

function asEncryptedNamedDocument(value: DocumentData) {
  return value as EncryptedNamedDocument
}

// Named documents are stored as plaintext records (version 2): sync does not
// require the encryption key, and one malformed or undecryptable document can
// no longer poison the whole collection. Legacy version-1 encrypted envelopes
// (with a `payload` field) are still decrypted when a key is available.
export async function decodeRemoteNamedDocument(id: string, value: DocumentData, key?: CryptoKey): Promise<NamedDocument | undefined> {
  try {
    if (value?.payload) {
      if (!key) return undefined
      return await decryptNamedDocument(asEncryptedNamedDocument(value), key)
    }
    if (typeof value?.markdown !== 'string' || typeof value?.updatedAt !== 'number') return undefined
    return {
      id,
      title: typeof value.title === 'string' ? value.title : '',
      markdown: value.markdown,
      lane: typeof value.lane === 'number' ? value.lane : 1,
      order: typeof value.order === 'number' ? value.order : 0,
      collapsed: value.collapsed === true,
      deleted: value.deleted === true ? true : undefined,
      updatedAt: value.updatedAt,
      writeId: typeof value.writeId === 'string' ? value.writeId : undefined,
    }
  } catch {
    return undefined
  }
}

function namedDocumentRecord(document: NamedDocument) {
  return {
    version: 2 as const,
    id: document.id,
    title: document.title,
    markdown: document.markdown,
    lane: document.lane,
    order: document.order,
    collapsed: document.collapsed,
    ...(document.deleted ? { deleted: true } : {}),
    updatedAt: document.updatedAt,
    ...(document.writeId ? { writeId: document.writeId } : {}),
  }
}

function withNamedSyncBase(document: NamedDocument): NamedDocument {
  const { writeId: _writeId, ...rest } = document
  return {
    ...rest,
    syncBase: { markdown: document.markdown, updatedAt: document.updatedAt },
    syncedMeta: namedMeta(document),
  }
}

function namedMeta(document: NamedDocument) {
  return { title: document.title, lane: document.lane, order: document.order, collapsed: document.collapsed, deleted: document.deleted }
}

// Named-note metadata (title/lane/order/collapsed/deleted) resolves
// last-writer-wins on the record's updatedAt; only markdown goes through the
// three-way merge.
function metaFrom(document: NamedDocument, fields: Partial<NamedDocument>): Pick<NamedDocument, 'title' | 'lane' | 'order' | 'collapsed' | 'deleted'> {
  return {
    title: fields.title ?? document.title,
    lane: fields.lane ?? document.lane,
    order: fields.order ?? document.order,
    collapsed: fields.collapsed ?? document.collapsed,
    deleted: fields.deleted,
  }
}

function asDailyShape(document: NamedDocument): DailyDocument {
  return { day: document.id, markdown: document.markdown, updatedAt: document.updatedAt, syncBase: document.syncBase, writeId: document.writeId }
}

function namedConflict(local: NamedDocument, remote: NamedDocument): SyncConflict {
  return { day: local.id, family: 'named', title: remote.title || local.title, local: asDailyShape(local), remote: asDailyShape(remote), base: local.syncBase }
}

function namedConflictResult(local: NamedDocument, remote: NamedDocument): NamedDocumentUploadResult {
  return { status: 'conflict', conflict: namedConflict(local, remote) }
}

export async function uploadNamedDocument(
  uid: string,
  document: NamedDocument,
  key?: CryptoKey,
  options: EncryptedDocumentUploadOptions = {},
): Promise<NamedDocumentUploadResult> {
  if (!firestore) throw new Error('Firebase is not configured')
  const documentRef = doc(namedDocumentsPath(uid), document.id)
  const writeId = crypto.randomUUID()
  return runTransaction(firestore, async (transaction) => {
    const snapshot = await transaction.get(documentRef)
    // An undecodable remote record is treated as absent — overwriting it with
    // the local plaintext record self-heals a poisoned document.
    const remote = snapshot.exists()
      ? await decodeRemoteNamedDocument(documentRef.id, snapshot.data(), key)
      : undefined
    const writeDocument = async (markdown: string) => {
      options.onWriteId?.(writeId)
      // Metadata is LWW on updatedAt: keep whichever side is newer while the
      // merged markdown is written.
      const meta = remote && remote.updatedAt > document.updatedAt ? metaFrom(document, remote) : namedMeta(document)
      const next: NamedDocument = { ...document, ...meta, markdown, updatedAt: Date.now(), writeId }
      transaction.set(documentRef, namedDocumentRecord(next))
      return { status: 'written' as const, document: withNamedSyncBase(next) }
    }

    const decision = resolveDocumentUpload(document, remote, options.strategy)
    // 'adopt' means identical markdown — but named docs also carry metadata
    // (title/lane/order/collapsed/deleted), so an adopt is only safe when the
    // meta matches too. Otherwise write the same markdown so the meta's LWW
    // resolution runs; without this a tombstone or rename would be dropped.
    const metaMatches = (current: NamedDocument) =>
      current.title === document.title && current.lane === document.lane && current.order === document.order && current.collapsed === document.collapsed && Boolean(current.deleted) === Boolean(document.deleted)
    if (decision.action === 'adopt' && metaMatches(remote!)) return { status: 'written', document: withNamedSyncBase(remote!) }
    if (decision.action === 'conflict') return namedConflictResult(document, remote!)
    return writeDocument(decision.action === 'adopt' ? document.markdown : decision.markdown)
  })
}

export async function syncNamedDocuments(uid: string, localDocuments: NamedDocument[], key?: CryptoKey, options: EncryptedDocumentUploadOptions = {}) {
  if (!firestore) throw new Error('Firebase is not configured')
  const remote = await getDocs(query(namedDocumentsPath(uid), orderBy('updatedAt', 'desc'), limit(1000)))
  const localById = new Map(localDocuments.map((document) => [document.id, document]))
  const remoteById = new Map<string, NamedDocument>()
  const merged = new Map<string, NamedDocument>()
  const conflicts: SyncConflict[] = []
  const uploads: { local: NamedDocument; remote?: NamedDocument }[] = []

  const metaSynced = (document: NamedDocument) => {
    const meta = document.syncedMeta
    return !!meta && meta.title === document.title && meta.lane === document.lane && meta.order === document.order && meta.collapsed === document.collapsed && meta.deleted === document.deleted
  }

  for (const snapshot of remote.docs) {
    const remoteDocument = await decodeRemoteNamedDocument(snapshot.id, snapshot.data(), key)
    if (!remoteDocument) continue
    remoteById.set(remoteDocument.id, remoteDocument)
    const localDocument = localById.get(remoteDocument.id)
    if (!localDocument) {
      merged.set(remoteDocument.id, withNamedSyncBase(remoteDocument))
      continue
    }
    if (localDocument.markdown === remoteDocument.markdown || localDocument.markdown === localDocument.syncBase?.markdown) {
      // Content settled; resolve metadata LWW and push if the local side wins.
      if (metaSynced(localDocument) && localDocument.updatedAt <= remoteDocument.updatedAt) {
        merged.set(remoteDocument.id, withNamedSyncBase(remoteDocument))
        continue
      }
      const meta = localDocument.updatedAt > remoteDocument.updatedAt ? namedMeta(localDocument) : metaFrom(localDocument, remoteDocument)
      const resolved: NamedDocument = { ...localDocument, ...meta }
      if (localDocument.updatedAt > remoteDocument.updatedAt) uploads.push({ local: resolved, remote: remoteDocument })
      else merged.set(remoteDocument.id, withNamedSyncBase({ ...remoteDocument }))
      continue
    }
    if (!localDocument.syncBase) {
      conflicts.push(namedConflict(localDocument, remoteDocument))
      merged.set(localDocument.id, localDocument)
      continue
    }
    uploads.push({ local: localDocument, remote: remoteDocument })
  }

  for (const document of localDocuments) {
    if (!remoteById.has(document.id)) uploads.push({ local: document })
  }

  const uploadResults = await Promise.all(uploads.map(({ local }) => uploadNamedDocument(uid, local, key, options)))
  uploadResults.forEach((result, index) => {
    const { local, remote: uploadRemote } = uploads[index]
    if (result.status === 'written') {
      merged.set(result.document.id, result.document)
      return
    }
    conflicts.push(result.conflict)
    merged.set(local.id, local)
    if (uploadRemote) remoteById.set(uploadRemote.id, uploadRemote)
  })

  return { documents: [...merged.values()], conflicts }
}

export function watchRemoteNamedDocuments(uid: string, key: CryptoKey | undefined, onDocuments: (documents: NamedDocument[]) => void, onError: (error: Error) => void) {
  if (!firestore) return () => undefined
  return onSnapshot(query(namedDocumentsPath(uid), orderBy('updatedAt', 'desc'), limit(1000)), (snapshot) => {
    void Promise.all(snapshot.docs.map((snapshot) => decodeRemoteNamedDocument(snapshot.id, snapshot.data(), key))).then((documents) => onDocuments(documents.filter((document): document is NamedDocument => Boolean(document)))).catch((error: unknown) => onError(error instanceof Error ? error : new Error(String(error))))
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
  const namedDocuments = await getDocs(namedDocumentsPath(uid))
  await Promise.all([...documents.docs, ...namedDocuments.docs].map((snapshot) => deleteDoc(snapshot.ref)))
  await deleteDoc(keyBundlePath(uid))
}
