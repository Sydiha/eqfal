-- UAT-007: extend evidence exception checks for physical cash opening balances.
-- Migration 097 is historical and remains unchanged. This forward-only migration
-- preserves every value previously accepted by 097 while adding cash_on_hand
-- and its two incomplete-evidence issue codes.

ALTER TABLE opening_balance_evidence_exceptions
  DROP CONSTRAINT opening_balance_evidence_exceptions_section_check,
  DROP CONSTRAINT opening_balance_evidence_exceptions_issue_code_check;

ALTER TABLE opening_balance_evidence_exceptions
  ADD CONSTRAINT opening_balance_evidence_exceptions_section_check
    CHECK (section IN ('bank', 'cash_on_hand', 'receivable', 'payable')),
  ADD CONSTRAINT opening_balance_evidence_exceptions_issue_code_check
    CHECK (issue_code IN (
      'OB_BANK_AGGREGATE_ONLY',
      'OB_PHYSICAL_CASH_EVIDENCE_MISSING',
      'OB_PHYSICAL_CASH_EVIDENCE_USER_DECLARED',
      'OB_REFERENCE_MISSING',
      'OB_BANK_EVIDENCE_MISSING',
      'OB_BANK_CURRENCY_NOT_COMPARABLE',
      'OB_FUNCTIONAL_CURRENCY_UNKNOWN',
      'OB_CONTROL_ACCOUNT_UNMAPPED',
      'OB_SUBLEDGER_AGGREGATE_ONLY',
      'OB_SUBLEDGER_UNLINKED_OBLIGATION',
      'OB_SUBLEDGER_TOTAL_DIFFERENCE'
    ));
