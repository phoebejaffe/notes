import { decryptText, encryptText, type EncryptedEnvelope } from './crypto'
import type { DailyDocument, NamedDocument } from './storage'

export interface EncryptedDailyDocument {
  version: 1
  day: string
  updatedAt: number
  payload: EncryptedEnvelope
}

export interface EncryptedNamedDocument {
  version: 1
  id: string
  updatedAt: number
  payload: EncryptedEnvelope
}

export interface SyncTransport {
  upload(document: EncryptedDailyDocument): Promise<void>
  downloadSince(cursor?: string): Promise<{ documents: EncryptedDailyDocument[]; cursor?: string }>
}

export async function encryptDailyDocument(document: DailyDocument, key: CryptoKey, writeId?: string): Promise<EncryptedDailyDocument> {
  const payload = JSON.stringify({ markdown: document.markdown, updatedAt: document.updatedAt, ...(writeId ? { writeId } : {}) })
  return { version: 1, day: document.day, updatedAt: document.updatedAt, payload: await encryptText(payload, key, `notes:daily-document:${document.day}`) }
}

export async function decryptDailyDocument(document: EncryptedDailyDocument, key: CryptoKey): Promise<DailyDocument> {
  const payload = JSON.parse(await decryptText(document.payload, key)) as { markdown: string; updatedAt: number; writeId?: string }
  if (typeof payload.markdown !== 'string' || typeof payload.updatedAt !== 'number') throw new Error('Invalid encrypted daily document payload')
  return { day: document.day, markdown: payload.markdown, updatedAt: payload.updatedAt, writeId: payload.writeId }
}

interface NamedDocumentPayload {
  title: string
  markdown: string
  lane: number
  order: number
  collapsed: boolean
  deleted?: boolean
  updatedAt: number
  writeId?: string
}

export async function encryptNamedDocument(document: NamedDocument, key: CryptoKey, writeId?: string): Promise<EncryptedNamedDocument> {
  const payload = JSON.stringify({
    title: document.title,
    markdown: document.markdown,
    lane: document.lane,
    order: document.order,
    collapsed: document.collapsed,
    ...(document.deleted ? { deleted: true } : {}),
    updatedAt: document.updatedAt,
    ...(writeId ? { writeId } : {}),
  } satisfies NamedDocumentPayload)
  return { version: 1, id: document.id, updatedAt: document.updatedAt, payload: await encryptText(payload, key, `notes:named-document:${document.id}`) }
}

export async function decryptNamedDocument(document: EncryptedNamedDocument, key: CryptoKey): Promise<NamedDocument> {
  const payload = JSON.parse(await decryptText(document.payload, key)) as NamedDocumentPayload
  if (typeof payload.markdown !== 'string' || typeof payload.updatedAt !== 'number' || typeof payload.title !== 'string') throw new Error('Invalid encrypted named document payload')
  return {
    id: document.id,
    title: payload.title,
    markdown: payload.markdown,
    lane: typeof payload.lane === 'number' ? payload.lane : 1,
    order: typeof payload.order === 'number' ? payload.order : 0,
    collapsed: payload.collapsed === true,
    deleted: payload.deleted === true ? true : undefined,
    updatedAt: payload.updatedAt,
    writeId: payload.writeId,
  }
}
