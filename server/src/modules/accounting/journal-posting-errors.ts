export class JournalPostingValidationError extends Error {}
export class JournalPostingNotFoundError extends Error {}
export class JournalPostingConflictError extends Error {}

/** A reversal that is refused for a business reason. `code` is stable for the client; the message is for logs and support. */
export class JournalReversalBlockedError extends JournalPostingConflictError {
  constructor(public readonly code: string, message: string) { super(message); }
}

export const OPENING_BALANCE_MANUAL_CODE = 'OPENING_BALANCE_MANUAL_JOURNAL_BLOCKED';
export const OPENING_BALANCE_CONTEXT_CODE = 'OPENING_BALANCE_REVIEW_CONTEXT_INVALID';

/** An opening-balance journal that is not created and posted by the approved opening-balance review workflow. `code` is stable for the client. */
export class OpeningBalanceJournalBlockedError extends JournalPostingConflictError {
  constructor(public readonly code: string, message: string, public readonly mismatches?: Array<{ account_id: string; code: string; expected: string; actual: string }>) { super(message); }
}

/** B1: a carry-forward opening balance that does not equal the originating year's closing position exactly. */
export const CARRYFORWARD_RECONCILIATION_CODE = 'CARRYFORWARD_RECONCILIATION_MISMATCH';

export const LEDGER_SOURCE_AUTHORITY_BLOCKED_CODE = 'LEDGER_SOURCE_AUTHORITY_BLOCKED';
export const ONBOARDING_PATH_CUTOVER_ACTIVE_CODE = 'ONBOARDING_PATH_CUTOVER_ACTIVE';
export const CUTOVER_JOURNAL_MANUAL_CODE = 'CUTOVER_JOURNAL_MANUAL_BLOCKED';
export const CUTOVER_CONTEXT_INVALID_CODE = 'CUTOVER_CONTEXT_INVALID';

/** A posting refused because the date (or the fiscal year, for an opening balance) is governed by an external-reference authority range. `code` is stable for the client. */
export class LedgerSourceAuthorityBlockedError extends JournalPostingConflictError {
  constructor(public readonly code: string, message: string) { super(message); }
}
