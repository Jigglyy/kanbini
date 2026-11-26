// Files copied in the OS file manager, read off the clipboard so Ctrl+V
// on an open card attaches the real files (a copied GIF keeps its
// animation, a PDF arrives as a PDF). Windows only for now: Electron
// exposes the FIRST copied file as the `FileNameW` format (UTF-16LE, NUL
// terminated); main asks PowerShell for the whole list only when that
// format is present. Pure helpers here so they're testable without
// Electron.

/** The path in a `FileNameW` clipboard buffer, or null when it's empty. */
export function decodeFileNameW(buf: Uint8Array): string | null {
  if (buf.length < 2) return null;
  const text = new TextDecoder("utf-16le").decode(buf);
  const nul = text.indexOf("\0");
  const path = (nul === -1 ? text : text.slice(0, nul)).trim();
  return path.length > 0 ? path : null;
}

/** The paths in `Get-Clipboard -Format FileDropList` output, one per
 *  line, in clipboard order. */
export function parseFileDropList(stdout: string): string[] {
  return stdout
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** The files to attach: the full list when it agrees with the first file
 *  Electron saw (the clipboard didn't change in between), else just that
 *  first file. Empty when there's no file on the clipboard. */
export function pastedFilePaths(first: string | null, all: readonly string[]): string[] {
  if (!first) return [];
  return all.includes(first) ? [...all] : [first];
}
