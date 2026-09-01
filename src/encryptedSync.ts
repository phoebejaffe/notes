import { decryptText, encryptText, type EncryptedEnvelope } from './crypto'
import type { DailyDocument } from './storage'

export interface EncryptedDailyDocument {
  version: 1
  day: string
  updatedAt: number
  payload: EncryptedEnvelope
}

export interface SyncTransport {
  upload(document: EncryptedDailyDocument): Promise<void>
  downloadSince(cursor?: string): Promise<{ documents: EncryptedDailyDocument[]; cursor?: string }>
}

export async function encryptDailyDocument(document: DailyDocument, key: CryptoKey): Promise<EncryptedDailyDocument> {
  const payload = JSON.stringify({ markdown: document.markdown, updatedAt: document.updatedAt })
  return { version: 1, day: document.day, updatedAt: document.updatedAt, payload: await encryptText(payload, key, `notes:daily-document:${document.day}`) }
}

export async function decryptDailyDocument(document: EncryptedDailyDocument, key: CryptoKey): Promise<DailyDocument> {
  const payload = JSON.parse(await decryptText(document.payload, key)) as { markdown: string; updatedAt: number }
  if (typeof payload.markdown !== 'string' || typeof payload.updatedAt !== 'number') throw new Error('Invalid encrypted daily document payload')
  return { day: document.day, markdown: payload.markdown, updatedAt: payload.updatedAt }
}
