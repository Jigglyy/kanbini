// @kanbini/db - Drizzle schema + migrations + connection. Data-access
// (service) helpers land with the IPC task; the renderer never imports
// this package (main process is the single writer, DESIGN §5).

import { SCHEMA_VERSION } from '@kanbini/shared'

export * as schema from './schema'
export * from './client'
export * from './crud'
export * from './data'
export * from './export'
export * from './import'
export * from './import-trello'
export * from './search'
export * from './templates'
export * from './undo'

export function dbInfo(): string {
  return `@kanbini/db (schema v${SCHEMA_VERSION})`
}
