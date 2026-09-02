import { describe, expect, it } from 'vitest'
import { defaultPreferences } from './preferences'

describe('preferences defaults', () => {
  it('enables empty days and Markdown bullet rendering by default', () => {
    expect(defaultPreferences.showEmptyDays).toBe(true)
    expect(defaultPreferences.renderBullets).toBe(true)
  })
})
