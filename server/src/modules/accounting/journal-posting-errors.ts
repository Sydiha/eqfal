export class JournalPostingValidationError extends Error {}
export class JournalPostingNotFoundError extends Error {}
export class JournalPostingConflictError extends Error {}

/** A reversal that is refused for a business reason. `code` is stable for the client; the message is for logs and support. */
export class JournalReversalBlockedError extends JournalPostingConflictError {
  constructor(public readonly code: string, message: string) { super(message); }
}
