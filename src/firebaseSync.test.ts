import { describe, expect, it } from 'vitest'
import { decodeRemoteNamedDocument, isStaleRemoteDocument, resolveDocumentUpload } from './firebaseSync'
import { encryptNamedDocument } from './encryptedSync'
import type { DailyDocument, NamedDocument } from './storage'

const document = (markdown: string, syncBase?: string): DailyDocument => ({
  day: '2026-09-19',
  markdown,
  updatedAt: 200,
  syncBase: syncBase === undefined ? undefined : { markdown: syncBase, updatedAt: 100 },
})
const remote = (markdown: string): DailyDocument => ({ day: '2026-09-19', markdown, updatedAt: 300 })

describe('resolveDocumentUpload', () => {
  it('writes a local document when no remote document exists', () => {
    expect(resolveDocumentUpload(document('local'), undefined)).toEqual({ action: 'write', markdown: 'local' })
  })

  it('adopts an identical remote document without writing', () => {
    expect(resolveDocumentUpload(document('same', 'base'), remote('same'))).toEqual({ action: 'adopt' })
  })

  it('writes local changes when remote still matches the sync base', () => {
    expect(resolveDocumentUpload(document('local', 'base'), remote('base'))).toEqual({ action: 'write', markdown: 'local' })
  })

  it('merges a remote transcription insertion with a local edit', () => {
    const local = document('first\n\nlocal edit', 'first\n\nbase')
    const latest = remote('💡 recording\n\nfirst\n\nbase')
    expect(resolveDocumentUpload(local, latest)).toEqual({
      action: 'write',
      markdown: '💡 recording\n\nfirst\n\nlocal edit',
    })
  })

  it('returns a conflict when local and remote change the same line', () => {
    expect(resolveDocumentUpload(document('local', 'base'), remote('remote'))).toEqual({ action: 'conflict' })
  })

  it('requires the expected remote version for conflict resolution replacement', () => {
    expect(resolveDocumentUpload(document('local', 'shown remote'), remote('shown remote'), 'replace')).toEqual({ action: 'write', markdown: 'local' })
    expect(resolveDocumentUpload(document('local', 'shown remote'), remote('newer remote'), 'replace')).toEqual({ action: 'conflict' })
  })
})

describe('isStaleRemoteDocument', () => {
  const ownSeq = new Map([
    ['w-old', 1],
    ['w-new', 2],
  ])

  it('is not stale when no remote version has been seen', () => {
    expect(isStaleRemoteDocument({ updatedAt: 100 }, undefined, ownSeq)).toBe(false)
  })

  it('is not stale for a newer remote version', () => {
    expect(isStaleRemoteDocument({ updatedAt: 200 }, { updatedAt: 100 }, ownSeq)).toBe(false)
  })

  it('is stale for an older remote version', () => {
    expect(isStaleRemoteDocument({ updatedAt: 100 }, { updatedAt: 200 }, ownSeq)).toBe(true)
  })

  it('is not stale for the same version', () => {
    expect(isStaleRemoteDocument({ updatedAt: 100, writeId: 'w-old' }, { updatedAt: 100, writeId: 'w-old' }, ownSeq)).toBe(false)
  })

  it('is stale for an older own commit sharing the same timestamp', () => {
    expect(isStaleRemoteDocument({ updatedAt: 100, writeId: 'w-old' }, { updatedAt: 100, writeId: 'w-new' }, ownSeq)).toBe(true)
  })

  it('is not stale for a newer own commit sharing the same timestamp', () => {
    expect(isStaleRemoteDocument({ updatedAt: 100, writeId: 'w-new' }, { updatedAt: 100, writeId: 'w-old' }, ownSeq)).toBe(false)
  })

  it('is not stale at the same timestamp when a writeId is not recognized as ours', () => {
    expect(isStaleRemoteDocument({ updatedAt: 100, writeId: 'unknown' }, { updatedAt: 100, writeId: 'w-new' }, ownSeq)).toBe(false)
    expect(isStaleRemoteDocument({ updatedAt: 100 }, { updatedAt: 100, writeId: 'w-new' }, ownSeq)).toBe(false)
  })
})

describe('decodeRemoteNamedDocument', () => {
  it('decodes a plaintext record with lane metadata', async () => {
    const decoded = await decodeRemoteNamedDocument('note-1', {
      version: 2,
      id: 'note-1',
      title: 'Ideas',
      markdown: '# Hello',
      lane: 2,
      order: 3,
      collapsed: true,
      updatedAt: 999,
      writeId: 'w-1',
    })
    expect(decoded).toEqual({
      id: 'note-1', title: 'Ideas', markdown: '# Hello',
      lane: 2, order: 3, collapsed: true, deleted: undefined, updatedAt: 999, writeId: 'w-1',
    })
  })

  it('decodes a plaintext tombstone', async () => {
    const decoded = await decodeRemoteNamedDocument('note-1', { version: 2, id: 'note-1', title: 'Gone', markdown: '', lane: 1, order: 0, deleted: true, updatedAt: 5 })
    expect(decoded?.deleted).toBe(true)
  })

  it('defaults missing optional fields without failing', async () => {
    const decoded = await decodeRemoteNamedDocument('note-1', { markdown: 'x', updatedAt: 1 })
    expect(decoded).toMatchObject({ id: 'note-1', title: '', markdown: 'x', lane: 1, order: 0, collapsed: false })
  })

  it.each([
    ['missing markdown', { updatedAt: 1 }],
    ['missing updatedAt', { markdown: 'x' }],
    ['wrong markdown type', { markdown: 42, updatedAt: 1 }],
    ['null', null],
    ['a string', 'not a document'],
  ])('skips a malformed record (%s)', async (_label, value) => {
    expect(await decodeRemoteNamedDocument('note-1', value as never)).toBeUndefined()
  })

  it('decodes a legacy encrypted envelope when a key is available', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const document: NamedDocument = { id: 'note-1', title: 'Todo', markdown: '- [ ] thing', lane: 4, order: 1, collapsed: false, updatedAt: 777 }
    const envelope = await encryptNamedDocument(document, key)
    expect(await decodeRemoteNamedDocument('note-1', envelope as never, key)).toEqual(document)
  })

  it('skips a legacy encrypted envelope when no key is available', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const envelope = await encryptNamedDocument({ id: 'note-1', title: 't', markdown: 'm', lane: 1, order: 0, collapsed: false, updatedAt: 1 }, key)
    expect(await decodeRemoteNamedDocument('note-1', envelope as never)).toBeUndefined()
  })

  it('skips a corrupt encrypted envelope instead of throwing', async () => {
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const corrupt = { version: 1, id: 'note-1', updatedAt: 1, payload: { associatedData: 'notes:named-document:note-1', iv: 'AAAA', ciphertext: 'BBBB' } }
    expect(await decodeRemoteNamedDocument('note-1', corrupt as never, key)).toBeUndefined()
  })
})
