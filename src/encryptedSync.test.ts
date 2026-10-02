import { describe, expect, it } from 'vitest'
import { createKeyBundle, createRecoveryKeyBackup, createRecoveryPhrase, decryptText, encryptText, readRecoveryKeyBackup, recoverDataKey } from './crypto'
import { decryptDailyDocument, decryptNamedDocument, encryptDailyDocument, encryptNamedDocument } from './encryptedSync'

describe('encrypted sync foundation', () => {
  it('encrypts and decrypts text with authenticated associated data', async () => {
    const { recoveryKey, bundle } = await createKeyBundle()
    const key = await recoverDataKey(recoveryKey, bundle)
    const envelope = await encryptText('private note', key, 'notes:daily-document:2026-09-01')
    expect(await decryptText(envelope, key)).toBe('private note')
    await expect(decryptText({ ...envelope, associatedData: 'notes:daily-document:other-day' }, key)).rejects.toThrow()
  })

  it('round-trips a daily document through an encrypted envelope', async () => {
    const { recoveryKey, bundle } = await createKeyBundle()
    const key = await recoverDataKey(recoveryKey, bundle)
    const document = { day: '2026-09-01', markdown: '# Private', updatedAt: 123 }
    const encrypted = await encryptDailyDocument(document, key)
    expect(await decryptDailyDocument(encrypted, key)).toEqual(document)
  })

  it('round-trips the write id used to recognize own-write echoes', async () => {
    const { recoveryKey, bundle } = await createKeyBundle()
    const key = await recoverDataKey(recoveryKey, bundle)
    const document = { day: '2026-09-01', markdown: '# Private', updatedAt: 123 }
    const encrypted = await encryptDailyDocument(document, key, 'write-123')
    expect(await decryptDailyDocument(encrypted, key)).toEqual({ ...document, writeId: 'write-123' })
  })

  it('round-trips a named document with its lane metadata', async () => {
    const { recoveryKey, bundle } = await createKeyBundle()
    const key = await recoverDataKey(recoveryKey, bundle)
    const document = { id: 'note-1', title: 'Ideas', markdown: '**notes**', lane: 2, order: 1, collapsed: true, updatedAt: 456 }
    const encrypted = await encryptNamedDocument(document, key, 'write-9')
    expect(encrypted.id).toBe('note-1')
    const decrypted = await decryptNamedDocument(encrypted, key)
    expect(decrypted).toEqual({ ...document, deleted: undefined, writeId: 'write-9' })
  })

  it('round-trips a named-document tombstone', async () => {
    const { recoveryKey, bundle } = await createKeyBundle()
    const key = await recoverDataKey(recoveryKey, bundle)
    const tombstone = { id: 'note-1', title: 'Gone', markdown: 'old', lane: 1, order: 0, collapsed: false, deleted: true, updatedAt: 789 }
    const decrypted = await decryptNamedDocument(await encryptNamedDocument(tombstone, key), key)
    expect(decrypted).toEqual({ ...tombstone, writeId: undefined })
    expect(decrypted.deleted).toBe(true)
  })

  it('creates a validated recovery-key backup', async () => {
    const recoveryPhrase = createRecoveryPhrase()
    expect(recoveryPhrase.split(' ')).toHaveLength(12)
    expect(readRecoveryKeyBackup(createRecoveryKeyBackup(recoveryPhrase))).toBe(recoveryPhrase)
    expect(() => readRecoveryKeyBackup('not-a-recovery-key')).toThrow()
  })
})
