// ADR-0056 - pure helpers for check-payload.mjs.
//
// Split out of the main script so the parser + sentinel-diff logic
// can be unit-tested without spawning 7z. The IO-touching parts
// (find7z, findInstaller, the actual spawnSync calls) stay in
// check-payload.mjs.

/** Parse the output of `7z l -slt <archive>` into a Set of normalized
 *  payload paths. Each entry in `-slt` mode is a key=value block, one
 *  of which is `Path = <name>`.
 *
 *  Three subtleties this helper handles that bit us during
 *  development:
 *
 *  - Windows line endings: 7z's stdout on Windows uses CRLF. A plain
 *    `split('\n')` leaves a trailing `\r` on each line, and the
 *    `$` end-of-line anchor in `^Path = (.+)$` refuses to match
 *    across `\r` (regex `.` doesn't include `\r`). Without splitting
 *    on `/\r?\n/` the parser silently returns an empty Set.
 *
 *  - Backslash separators: 7z reports archive paths with `\` on
 *    Windows. Sentinel paths in the allow-list are written with `/`
 *    for readability; normalizing on parse means the comparison is
 *    a straight `Set.has()`.
 *
 *  - Archive metadata: the first `Path = ...` line in 7z's output
 *    is the path to the archive itself (the one we passed as the
 *    argument), not an entry inside it. We could filter it out by
 *    checking against the archive path, but in practice it doesn't
 *    collide with any sentinel (sentinels use `resources/...`,
 *    archive path is an absolute `C:\...`) so leaving it in is
 *    harmless. */
export function parsePathListing(stdout) {
  const present = new Set()
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^Path = (.+)$/)
    if (m) present.add(m[1].trim().replace(/\\/g, '/'))
  }
  return present
}

/** Given the Set of paths actually present in the payload + the
 *  list of paths we required to be there, return the missing ones
 *  in the original required-list order. Empty array = pass. */
export function findMissingSentinels(present, required) {
  return required.filter((s) => !present.has(s))
}
