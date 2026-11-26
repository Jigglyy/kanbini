import { execFile } from 'node:child_process'
import { clipboard } from 'electron'
import { decodeFileNameW, parseFileDropList, pastedFilePaths } from '@kanbini/shared'

// Files copied in Explorer, for Ctrl+V on an open card (see
// @kanbini/shared clipboard-files.ts). Electron only exposes the FIRST
// copied file (`FileNameW`); PowerShell's Get-Clipboard lists them all.
// PowerShell only runs when a file is actually on the clipboard, so a
// text or screenshot paste stays instant. Windows only: elsewhere this
// returns [] and the paste falls back to the clipboard image.

const LIST_FILES =
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ' +
  'Get-Clipboard -Format FileDropList | ForEach-Object { $_.FullName }'

function powershellFileList(): Promise<string[]> {
  return new Promise((done) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', LIST_FILES],
      { timeout: 5000, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => done(err ? [] : parseFileDropList(stdout))
    )
  })
}

/** The files on the clipboard (copied in Explorer), in order; [] when
 *  there are none or off Windows. */
export async function clipboardFilePaths(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  const first = decodeFileNameW(clipboard.readBuffer('FileNameW'))
  if (!first) return []
  return pastedFilePaths(first, await powershellFileList())
}
