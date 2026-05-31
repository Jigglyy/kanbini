#!/usr/bin/env node
// Icon pipeline (ADR-0051).
//
// Turns the hand-supplied source PNGs in `<repo-root>/images/` into the
// platform-specific files electron-builder expects under
// `apps/desktop/build/`. Idempotent - re-running the script overwrites
// the outputs; missing sources are skipped with a warning, not an
// error, so a partially-supplied images/ folder still produces what it
// can.
//
// Mapping (matches the numbered prompts in ICONS.md):
//   Image #1.png  →  build/icon.ico   (Windows multi-res ICO)
//                    build/icon.png   (Linux AppImage, 512×512)
//                    [icon.icns       - Mac, deferred per ADR-0040]
//   Image #2.png  →  build/installerIcon.ico   (NSIS install wizard)
//   Image #3.png  →  build/uninstallerIcon.ico (NSIS uninstall wizard)
//   Image #4.png  →  build/installerHeader.bmp (150×57)
//   Image #5.png  →  build/installerSidebar.bmp (164×314)
//   Image #7–10   →  build/brand/*.png (marketing kit, not packaged -
//                    copied at source resolution for now)
//
// Deps: jimp (pure-JS PNG/BMP encode + resize) + png-to-ico (multi-res
// ICO encoder over jimp's PNG output). Both pure JS - no allowBuilds
// entry needed in pnpm-workspace.yaml.

import { mkdir, readFile, writeFile, copyFile, access } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Jimp } from 'jimp'
import pngToIco from 'png-to-ico'

const HERE = dirname(fileURLToPath(import.meta.url))
const DESKTOP_ROOT = resolve(HERE, '..')
const REPO_ROOT = resolve(DESKTOP_ROOT, '../..')
const SRC_DIR = join(REPO_ROOT, 'images')
const OUT_DIR = join(DESKTOP_ROOT, 'build')
const BRAND_DIR = join(OUT_DIR, 'brand')
// Renderer asset folder. The script ALSO writes a runtime-friendly
// PNG of the brand mark here so the in-app header can render it
// without reaching across packages or pulling from `build/`.
const RENDERER_ASSETS = resolve(REPO_ROOT, 'apps/renderer/src/assets')

// Multi-res ICO embeds these sizes (electron-builder + NSIS expect the
// full set; small sizes are what Windows actually paints for the
// taskbar/Start menu).
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

async function exists(p) {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function loadSource(name) {
  const p = join(SRC_DIR, name)
  if (!(await exists(p))) {
    console.warn(`[icons] skip ${name} - not found at ${p}`)
    return null
  }
  return Jimp.read(p)
}

// Render `img` at each size and feed the resulting PNG buffers to
// png-to-ico, which packs them into a multi-resolution .ico container.
async function writeIco(img, outPath, sizes = ICO_SIZES) {
  const pngBuffers = []
  for (const size of sizes) {
    const copy = img.clone()
    copy.resize({ w: size, h: size })
    pngBuffers.push(await copy.getBuffer('image/png'))
  }
  const ico = await pngToIco(pngBuffers)
  await writeFile(outPath, ico)
  console.log(`[icons] wrote ${outPath} (${sizes.join(',')})`)
}

async function writePng(img, outPath, w, h = w) {
  const copy = img.clone()
  copy.resize({ w, h })
  const buf = await copy.getBuffer('image/png')
  await writeFile(outPath, buf)
  console.log(`[icons] wrote ${outPath} (${w}×${h})`)
}

async function writeBmp(img, outPath, w, h) {
  const copy = img.clone()
  copy.resize({ w, h })
  const buf = await copy.getBuffer('image/bmp')
  await writeFile(outPath, buf)
  console.log(`[icons] wrote ${outPath} (${w}×${h})`)
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  await mkdir(BRAND_DIR, { recursive: true })

  // --- Tier 1 - app icon (Windows + Linux; macOS deferred) ----------
  const appIcon = await loadSource('Image #1.png')
  if (appIcon) {
    await writeIco(appIcon, join(OUT_DIR, 'icon.ico'))
    await writePng(appIcon, join(OUT_DIR, 'icon.png'), 512)
  }

  // --- Renderer asset - brand mark for the in-app header -----------
  // The App.tsx header used to render `<LayoutGrid>` as a stand-in.
  // We resize the source app icon down to a renderer-friendly size
  // and drop it next to empty-board.svg so the renderer can import
  // it normally. 128 × 128 is plenty for a 24 px display slot at
  // 2× DPR, and keeps the bundled asset small.
  await mkdir(RENDERER_ASSETS, { recursive: true })
  if (appIcon) {
    await writePng(appIcon, join(RENDERER_ASSETS, 'logo.png'), 128)
  }

  // --- Tier 2 - installer polish (Windows NSIS) ---------------------
  const installerIcon = await loadSource('Image #2.png')
  if (installerIcon) {
    await writeIco(installerIcon, join(OUT_DIR, 'installerIcon.ico'))
  }
  const uninstallerIcon = await loadSource('Image #3.png')
  if (uninstallerIcon) {
    await writeIco(uninstallerIcon, join(OUT_DIR, 'uninstallerIcon.ico'))
  }
  const installerHeader = await loadSource('Image #4.png')
  if (installerHeader) {
    await writeBmp(installerHeader, join(OUT_DIR, 'installerHeader.bmp'), 150, 57)
  }
  const installerSidebar = await loadSource('Image #5.png')
  if (installerSidebar) {
    await writeBmp(installerSidebar, join(OUT_DIR, 'installerSidebar.bmp'), 164, 314)
  }

  // --- Tier 4 - brand kit (not packaged; stashed for future use) ----
  // Just copy through at source resolution - nothing consumes these
  // yet, but keeping them under build/brand/ ties them to the same
  // release artefact as the icons.
  for (const [src, dst] of [
    ['Image #7.png', 'logo.png'],
    ['Image #8.png', 'wordmark.png'],
    ['Image #9.png', 'favicon-source.png'],
    ['Image #10.png', 'og-card.png']
  ]) {
    const srcPath = join(SRC_DIR, src)
    if (await exists(srcPath)) {
      const dstPath = join(BRAND_DIR, dst)
      await copyFile(srcPath, dstPath)
      console.log(`[icons] copied ${dstPath}`)
    } else {
      console.warn(`[icons] skip brand ${src} - not found`)
    }
  }

  console.log('[icons] done')
}

main().catch((err) => {
  console.error('[icons] failed:', err)
  process.exit(1)
})
