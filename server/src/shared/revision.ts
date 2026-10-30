import type { Request, Response } from 'express';

/**
 * Stale-write protection (G7). A caller sends the row revision it last read in the `If-Match` header (a positive integer, optionally quoted).
 * The service compares it with the row's `version` inside the row-locked transaction, so exactly one of two edits made from the same
 * revision can succeed; the other gets a 409 and nothing is written.
 */
export class StaleRevisionError extends Error {
  /** 409 when the supplied revision is stale, 428 when the caller sent none. */
  constructor(readonly code: string, readonly status: 409 | 428 = 409) {
    super(status === 428 ? 'The record revision is required' : 'The record was changed by someone else; reload and try again');
  }
}

/**
 * Called by the service inside the row-locked transaction, after the tenant-scoped row was found (so a foreign id still answers 404 first).
 * `undefined` = internal caller that skips the check; `null` = the API caller sent no revision.
 */
export function assertRevision(expected: number | null | undefined, actual: number, code: string): void {
  if (expected === undefined) return;
  if (expected === null) throw new StaleRevisionError('REVISION_REQUIRED', 428);
  if (expected !== actual) throw new StaleRevisionError(code);
}

/** Parses `If-Match`: a number, null when absent, or false after answering 400 for a malformed value. */
export function readExpectedRevision(req: Request, res: Response): number | null | false {
  const raw = req.header('if-match');
  if (raw === undefined || raw.trim() === '') return null;
  const match = /^"?([1-9]\d{0,8})"?$/.exec(raw.trim());
  if (!match) {
    res.status(400).json({ error: 'Invalid record revision', code: 'REVISION_INVALID' });
    return false;
  }
  return Number(match[1]);
}
