import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: vi.fn()
  }
}))

import { decodeImageDataUrl, renderFileName, sanitizeFileName } from '../../src/main/save-service'

describe('save service utilities', () => {
  it('removes cross-platform illegal filename characters and reserved names', () => {
    expect(sanitizeFileName('  project:<one>|shot?.png  ')).toBe('project--one--shot-.png')
    expect(sanitizeFileName('CON')).toBe('_CON')
  })

  it('renders deterministic local naming tokens', () => {
    const now = new Date(2026, 7, 26, 9, 8, 7, 6)
    expect(renderFileName('Brclio {mode} {date} {time}', 'scroll', now)).toBe(
      'Brclio 长截图 2026-08-26 09.08.07.006'
    )
  })

  it('only accepts bounded supported image data URLs', () => {
    const buffer = Buffer.from('brclio')
    expect(decodeImageDataUrl(`data:image/png;base64,${buffer.toString('base64')}`)).toEqual(buffer)
    expect(() => decodeImageDataUrl('data:text/plain;base64,YQ==')).toThrow('格式无效')
  })
})
