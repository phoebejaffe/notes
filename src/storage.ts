export interface DailyDocument {
  day: string
  markdown: string
  updatedAt: number
}

const databaseName = 'notes-local'
const storeName = 'daily-documents'

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'day' })
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
    const request = database.transaction(storeName, 'readwrite').objectStore(storeName).put(document)
    request.onsuccess = () => resolve()
    request.onerror = () => reject(request.error)
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
  const database = await openDatabase()
  return new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    store.clear()
    documents.forEach((document) => store.put(document))
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}
