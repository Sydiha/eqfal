/**
 * Stable machine-readable codes for 409 rejections in bank reconciliation and document settlement.
 * The HTTP status and the legacy `error` message are unchanged; the code is derived from the exact message
 * of a confirmed rejection. Messages not listed here stay code-free (the client uses its fallback).
 */
const BANKING_CONFLICT_CODES: Readonly<Record<string, string>> = {
  'Bank transaction is already matched': 'BANK_TRANSACTION_ALREADY_MATCHED',
  'Bank transaction direction is incompatible with document type': 'BANK_DIRECTION_INCOMPATIBLE',
  'Document is not eligible for matching': 'DOCUMENT_NOT_ELIGIBLE_FOR_MATCHING',
  'Document must be approved before settlement': 'DOCUMENT_NOT_APPROVED',
  'Document total amount is required before settlement': 'DOCUMENT_TOTAL_REQUIRED',
  'All allocated documents must belong to the same counterparty': 'BANK_ALLOCATION_COUNTERPARTY_MISMATCH',
  'Allocations exceed the bank transaction amount': 'BANK_ALLOCATION_EXCEEDS_AMOUNT',
  'Allocations exceed an allowed limit': 'BANK_ALLOCATION_EXCEEDS_LIMIT',
  'Bank transaction is not matched': 'BANK_TRANSACTION_NOT_MATCHED',
  'Bank transaction must be matched first': 'BANK_TRANSACTION_NOT_MATCHED',
  'Bank transaction must be matched to this document first': 'BANK_TRANSACTION_NOT_MATCHED',
  'Bank transaction is not fully allocated': 'BANK_TRANSACTION_NOT_FULLY_ALLOCATED',
  'Allocate the bank transaction to its documents before reconciling': 'BANK_TRANSACTION_NOT_FULLY_ALLOCATED',
  'Reopen reconciliation before allocating': 'BANK_RECONCILIATION_REOPEN_REQUIRED',
  'Reopen reconciliation before unmatching': 'BANK_RECONCILIATION_REOPEN_REQUIRED',
  'Delete the payment settlement before unmatching': 'BANK_SETTLEMENT_DELETE_REQUIRED',
  'Delete the payment settlement before reopening reconciliation': 'BANK_SETTLEMENT_DELETE_REQUIRED',
  'Custody bank relationships must be changed from the custody workflow': 'BANK_TRANSACTION_CUSTODY_MANAGED',
  'Invalid reconciliation transition': 'BANK_RECONCILIATION_INVALID_TRANSITION',
  'Bank transaction already has a settlement': 'BANK_TRANSACTION_ALREADY_SETTLED',
  'Bank transaction already has an obligation settlement': 'BANK_TRANSACTION_ALREADY_LINKED',
  'Settlement amount exceeds an allowed limit': 'SETTLEMENT_LIMIT_EXCEEDED',
  'Settlement amount exceeds bank transaction unallocated amount': 'SETTLEMENT_EXCEEDS_BANK_UNALLOCATED',
  'Settlement amount exceeds document remaining amount': 'SETTLEMENT_EXCEEDS_DOCUMENT_REMAINING',
  'Settlement amount exceeds linked obligation remaining amount': 'SETTLEMENT_EXCEEDS_OBLIGATION_REMAINING',
};

/** `{ error, code? }` body for a banking 409 conflict. */
export function bankingConflictBody(message: string): { error: string; code?: string } {
  const code = BANKING_CONFLICT_CODES[message];
  return code ? { error: message, code } : { error: message };
}
