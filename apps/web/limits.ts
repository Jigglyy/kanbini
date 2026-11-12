// Request size limits, shared by the gateway (which refuses a request that
// declares a bigger body before forwarding it) and each app (which counts the
// bytes of bodies that don't declare a size). Room for real attachments and
// board files, but one account can't fill the server's disk or memory with
// a few requests. Cloudflare stops uploads at 100 MB too; the LAN address
// has no such limit.
export const MAX_UPLOAD = 100 * 1024 * 1024 // a file (an attachment, an import)
export const MAX_JSON = 5 * 1024 * 1024 // any other API call

/** The limit for a request to the app's /api/ routes. */
export const limitFor = (headers: { [name: string]: unknown }) =>
  typeof headers['x-kanbini-filename'] === 'string' ? MAX_UPLOAD : MAX_JSON
