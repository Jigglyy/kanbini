// Vite-supplied import suffixes used by the renderer. Lives in its
// own .d.ts (a pure script file - no imports/exports) so the ambient
// `declare module` patterns are treated as global module
// augmentations under Bundler module resolution.

// `import foo from './bar.svg?raw'` returns the SVG source as a
// string. We use it for inline-rendered SVGs so `currentColor`
// can pick up the surrounding text colour - an `<img src>`
// reference can't.
declare module '*.svg?raw' {
  const src: string
  export default src
}

// Default asset imports - Vite returns a resolved URL string the
// browser can load via `<img src>`, CSS url(), etc.
declare module '*.png' {
  const src: string
  export default src
}
declare module '*.svg' {
  const src: string
  export default src
}
