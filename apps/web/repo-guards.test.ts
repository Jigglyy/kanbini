// The web edition builds from the desktop app's unchanged sources, so a
// desktop change can break it without touching apps/web. These checks run
// in `pnpm test` (and so `pnpm verify` and CI), not only in the Docker
// build, so the break shows up in the change that causes it.
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import * as shim from './electron-shim'
import { rewriteForBrowser, WEB_SWAPS } from './swaps'

const repo = resolve(__dirname, '../..')

describe('WEB_SWAPS', () => {
  for (const file of Object.keys(WEB_SWAPS)) {
    it(`every swap still finds its text in ${file}`, () => {
      const code = readFileSync(join(repo, 'apps/renderer/src', file), 'utf8')
      expect(rewriteForBrowser(file, code).missing.map(String)).toEqual([])
    })
  }
})

/** Every .ts file under a folder, tests excluded. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sources(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

describe('electron-shim', () => {
  // What the desktop main process takes from Electron, file by file: the
  // value imports, and every `x.member` read on one of them.
  const uses = sources(join(repo, 'apps/desktop/src/main')).map((path) => {
    const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
    const imports = new Set<string>()
    const members = new Set<string>()
    let otherImport = false
    file.forEachChild((node) => {
      if (!ts.isImportDeclaration(node) || (node.moduleSpecifier as ts.StringLiteral).text !== 'electron') return
      const clause = node.importClause
      if (!clause || clause.isTypeOnly) return
      if (clause.name || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) {
        otherImport = true // a default or namespace import, which the checks below can't follow
        return
      }
      for (const el of clause.namedBindings.elements) {
        if (!el.isTypeOnly) imports.add((el.propertyName ?? el.name).text)
      }
    })
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && imports.has(node.expression.text)) {
        members.add(`${node.expression.text}.${node.name.text}`)
      }
      node.forEachChild(visit)
    }
    visit(file)
    return { path: relative(repo, path), imports, members, otherImport }
  })

  it('main imports Electron by name only', () => {
    expect(uses.filter((u) => u.otherImport).map((u) => u.path)).toEqual([])
  })

  it('exports everything main imports from Electron', () => {
    const missing = uses.flatMap((u) => [...u.imports].filter((name) => !(name in shim)).map((name) => `${u.path}: ${name}`))
    expect(missing).toEqual([])
  })

  it('has every member main reads on its plain-object stand-ins', () => {
    // Menu, Tray, nativeImage, screen and session are catch-all no-ops;
    // these are real objects, so a member main starts using must be added.
    const shaped: Record<string, object> = {
      app: shim.app,
      BrowserWindow: shim.BrowserWindow,
      clipboard: shim.clipboard,
      dialog: shim.dialog,
      ipcMain: shim.ipcMain,
      protocol: shim.protocol,
      shell: shim.shell
    }
    const missing = uses.flatMap((u) =>
      [...u.members].filter((m) => {
        const [object, member] = m.split('.') as [string, string]
        return object in shaped && !(member in shaped[object]!)
      }).map((m) => `${u.path}: ${m}`)
    )
    expect(missing).toEqual([])
  })
})

describe('Dockerfile', () => {
  it('copies every workspace package manifest before installing', () => {
    const dockerfile = readFileSync(join(repo, 'Dockerfile'), 'utf8')
    const packages = ['apps', 'packages'].flatMap((root) =>
      readdirSync(join(repo, root)).filter((name) => existsSync(join(repo, root, name, 'package.json'))).map((name) => `${root}/${name}`)
    )
    expect(packages.length).toBeGreaterThan(0)
    expect(packages.filter((p) => !dockerfile.includes(`COPY ${p}/package.json ${p}/`))).toEqual([])
  })
})
