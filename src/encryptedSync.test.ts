import { describe, expect, it } from 'vitest'
import { createKeyBundle, createRecoveryKeyBackup, createRecoveryPhrase, decryptText, encryptText, readRecoveryKeyBackup, recoverDataKey } from './crypto'
import { decryptDailyDocument, encryptDailyDocument } from './encryptedSync'

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

  it('creates a validated recovery-key backup', async () => {
    const recoveryPhrase = createRecoveryPhrase()
    expect(recoveryPhrase.split(' ')).toHaveLength(12)
    expect(readRecoveryKeyBackup(createRecoveryKeyBackup(recoveryPhrase))).toBe(recoveryPhrase)
    expect(() => readRecoveryKeyBackup('not-a-recovery-key')).toThrow()
  })
})
