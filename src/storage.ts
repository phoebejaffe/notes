export interface DocumentSyncBase {
  markdown: string
  updatedAt: number
}

export interface DailyDocument {
  day: string
  markdown: string
  updatedAt: number
  syncBase?: DocumentSyncBase
  writeId?: string
}

export interface NamedDocument {
  id: string
  title: string
  markdown: string
  lane: number
  order: number
  collapsed: boolean
  deleted?: boolean
  updatedAt: number
  syncBase?: DocumentSyncBase
  syncedMeta?: { title: string; lane: number; order: number; collapsed: boolean; deleted?: boolean }
  writeId?: string
}

const databaseName = 'notes-local'
const storeName = 'daily-documents'
const namedStoreName = 'named-documents'

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 2)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(storeName)) database.createObjectStore(storeName, { keyPath: 'day' })
      if (!database.objectStoreNames.contains(namedStoreName)) database.createObjectStore(namedStoreName, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function loadDailyDocument(day: string) {
  const database = await openDatabase()
  return new Promise<DailyDocument | undefined>((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).get(day)
    request.onsuccess = () => resolve(request.result as DailyDocument | undefined)
    request.onerror = () => reject(request.error)
  })
}

export async function saveDailyDocument(document: DailyDocument) {
  const database = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const request = store.get(document.day)
    request.onsuccess = () => {
      const existing = request.result as DailyDocument | undefined
      store.put({ ...existing, ...document, syncBase: document.syncBase ?? existing?.syncBase })
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function listDailyDocuments() {
  const database = await openDatabase()
  return new Promise<DailyDocument[]>((resolve, reject) => {
    const request = database.transaction(storeName, 'readonly').objectStore(storeName).getAll()
    request.onsuccess = () => resolve(request.result as DailyDocument[])
    request.onerror = () => reject(request.error)
  })
}

export async function replaceDailyDocuments(documents: DailyDocument[]) {
  const existing = new Map((await listDailyDocuments()).map((document) => [document.day, document]))
  const database = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    store.clear()
    documents.forEach((document) => {
      store.put({ ...document, syncBase: document.syncBase ?? existing.get(document.day)?.syncBase })
    })
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function clearSyncBases() {
  const documents = await listDailyDocuments()
  const database = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    documents.forEach((document) => {
      const next = { ...document }
      delete next.syncBase
      store.put(next)
    })
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function listNamedDocuments() {
  const database = await openDatabase()
  return new Promise<NamedDocument[]>((resolve, reject) => {
    const request = database.transaction(namedStoreName, 'readonly').objectStore(namedStoreName).getAll()
    request.onsuccess = () => resolve(request.result as NamedDocument[])
    request.onerror = () => reject(request.error)
  })
}

export async function saveNamedDocument(document: NamedDocument) {
  const database = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(namedStoreName, 'readwrite')
    const store = transaction.objectStore(namedStoreName)
    const request = store.get(document.id)
    request.onsuccess = () => {
      const existing = request.result as NamedDocument | undefined
      store.put({ ...existing, ...document, syncBase: document.syncBase ?? existing?.syncBase, syncedMeta: document.syncedMeta ?? existing?.syncedMeta })
    }
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function deleteNamedDocument(id: string) {
  const database = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(namedStoreName, 'readwrite')
    transaction.objectStore(namedStoreName).delete(id)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function clearNamedSyncBases() {
  const documents = await listNamedDocuments()
  const database = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(namedStoreName, 'readwrite')
    const store = transaction.objectStore(namedStoreName)
    documents.forEach((document) => {
      const next = { ...document }
      delete next.syncBase
      delete next.syncedMeta
      store.put(next)
    })
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}
