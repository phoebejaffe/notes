import { describe, expect, it } from 'vitest'
import { resolveDocumentUpload } from './firebaseSync'
import type { DailyDocument } from './storage'

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
