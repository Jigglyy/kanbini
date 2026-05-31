import { z } from 'zod'

// Must run BEFORE any `@kanbini/shared` schema is imported. Zod 4
// builds a `new Function(...)` probe lazily on the first ZodObject
// construction (util.js → `allowsEval`); jitless: true short-circuits
// that probe so the renderer's strict CSP doesn't log a violation on
// every load. ESM evaluates imports in source order, so this file
// must be imported on the FIRST line of main.tsx - ahead of React,
// App, anything that transitively pulls in shared schemas.
z.config({ jitless: true })
