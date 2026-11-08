# Phase 14 Owner UAT — Manager-Facing Financial Workflows

Run only in the approved synthetic test environment at the SHA selected for UAT. Do not use production or real customer/bank data. Record the active company, user role, fiscal period, timestamps, visible result, and any related API/audit evidence.

1. **Company and role context:** Sign in as Company Manager and Accountant in turn. Confirm the active company and fiscal year shown in the UI. Verify a user without the relevant capability cannot approve, post, reconcile, close, or approve a package; capture the visible denial and confirm the underlying record is unchanged.
2. **Sale/purchase and evidence:** Open a synthetic sale and purchase with attached source documents. Follow the supported review/approval flow. Check displayed source, tax, obligation, and journal totals against the report/API values; capture IDs and audit history.
3. **Expense and bank match:** Open an approved expense document, inspect its payable obligation and journal. Import one synthetic bank CSV, confirm it, match the transaction to an eligible document, and reconcile it. Attempt the same import again; expect a conflict and no duplicate transaction or settlement.
4. **Manual journal:** As an authorized accounting role, create a small balanced journal and post it. Confirm debit equals credit and the audit history records the actor. As a role without posting permission, attempt posting and confirm denial with no status or ledger change.
5. **Monthly close:** Review the period's authoritative blockers. As an unauthorized role, attempt close and confirm denial/no state change. As the authorized role, close only after blockers are resolved. Confirm the closed state and audit entry, then attempt a dated write to the closed period; confirm denial and unchanged records.
6. **Statements and annual package:** Review Trial Balance, profit or loss, financial position, cash flow, and changes in equity. Compare totals to the approved ledger and mappings. Inspect package readiness, fingerprint, and lifecycle state. Do not present internal package approval as an external audit certification.

Capture screenshots only as supplementary evidence. Record exact values, IDs, HTTP status/error code, before/after state, and audit events in the evidence archive; redact credentials and secrets.
