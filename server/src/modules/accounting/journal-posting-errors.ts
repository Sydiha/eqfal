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
  constructor(public readonly code: string, message: string) { super(message); }
}
