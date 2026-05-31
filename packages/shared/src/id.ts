import { v7 as uuidv7 } from 'uuid'

// UUIDv7 (ADR-0011): time-ordered, no central sequence - ids sort
// roughly by creation, which keeps SQLite indexes/scans friendly for
// an offline single-user app.

/** Mint a new entity id (UUIDv7, lowercase canonical form). */
export function newId(): string {
  return uuidv7()
}
