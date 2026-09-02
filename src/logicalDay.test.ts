import { describe, expect, it } from 'vitest'
import { formatLogicalDay, logicalDayKey, shiftLogicalDay } from './logicalDay'

describe('logical day', () => {
  it('keeps notes before 4am on the previous day', () => {
    expect(logicalDayKey(new Date(2026, 8, 1, 3, 59))).toBe('2026-08-31')
    expect(logicalDayKey(new Date(2026, 8, 1, 4, 0))).toBe('2026-09-01')
  })

  it('moves between daily documents', () => {
    expect(shiftLogicalDay('2026-09-01', -1)).toBe('2026-08-31')
    expect(shiftLogicalDay('2026-09-01', 1)).toBe('2026-09-02')
  })

  it('formats a daily document for the current locale', () => {
    expect(formatLogicalDay('2026-09-01')).toContain('September')
  })

  it('supports configurable rollover hours', () => {
    expect(logicalDayKey(new Date(2026, 8, 1, 0, 30), 0)).toBe('2026-09-01')
    expect(logicalDayKey(new Date(2026, 8, 1, 4, 30), 5)).toBe('2026-08-31')
  })

  it('supports ISO date display', () => {
    expect(formatLogicalDay('2026-09-01', 'iso')).toBe('2026-09-01')
  })
})
