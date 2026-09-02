import { describe, expect, it } from 'vitest'
import { defaultPreferences } from './preferences'

describe('preferences defaults', () => {
  it('shows empty days by default', () => {
    expect(defaultPreferences.showEmptyDays).toBe(true)
  })
})
