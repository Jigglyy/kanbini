import { describe, expect, it } from 'vitest'
import { decodeFileNameW, parseFileDropList, pastedFilePaths } from '../clipboard-files'

const utf16 = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length * 2)
  for (let i = 0; i < s.length; i++) {
    out[i * 2] = s.charCodeAt(i) & 0xff
    out[i * 2 + 1] = s.charCodeAt(i) >> 8
  }
  return out
}

describe('clipboard file paste', () => {
  it('decodes the FileNameW buffer up to its NUL', () => {
    expect(decodeFileNameW(utf16('C:\Pics\cat.gif\0\0'))).toBe('C:\Pics\cat.gif')
    expect(decodeFileNameW(utf16('C:\Ünïcode\ä.png\0'))).toBe('C:\Ünïcode\ä.png')
    expect(decodeFileNameW(new Uint8Array())).toBeNull()
    expect(decodeFileNameW(utf16('\0\0'))).toBeNull()
  })

  it('parses the PowerShell file list', () => {
    expect(parseFileDropList('\uFEFFC:\a.gif\r\nC:\b c.pdf\r\n\r\n')).toEqual([
      'C:\a.gif',
      'C:\b c.pdf'
    ])
    expect(parseFileDropList('')).toEqual([])
  })

  it('uses the full list only when it matches the first file', () => {
    expect(pastedFilePaths('C:\a.gif', ['C:\a.gif', 'C:\b.pdf'])).toEqual([
      'C:\a.gif',
      'C:\b.pdf'
    ])
    // PowerShell failed, or the clipboard changed in between.
    expect(pastedFilePaths('C:\a.gif', [])).toEqual(['C:\a.gif'])
    expect(pastedFilePaths('C:\a.gif', ['C:\other.txt'])).toEqual(['C:\a.gif'])
    expect(pastedFilePaths(null, ['C:\a.gif'])).toEqual([])
  })
})
