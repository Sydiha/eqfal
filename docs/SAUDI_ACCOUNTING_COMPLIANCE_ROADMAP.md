# EQFAL — Saudi Accounting & Tax Compliance Roadmap

Status: Approved project guidance
Date: 2026-09-06

## Purpose

This document records the accounting and Saudi-compliance gaps that must be addressed before EQFAL is considered functionally complete for real company use.

EQFAL is not intended to replace the professional judgment of an accountant, auditor, tax adviser, SOCPA, or ZATCA requirements. The product should collect operational truth, apply deterministic controls, prevent contradictory inputs, surface exceptions, and route judgment-sensitive matters to an authorized accountant/reviewer.

## Permanent product rule: non-accountant operator

The project owner/operator is treated as a non-accountant user.

Therefore EQFAL must not require a non-accountant operator to make unexplained accounting judgments. For accounting-sensitive workflows the system should, where appropriate:

- explain the accounting effect in plain language;
- provide safe defaults only when deterministic;
- block contradictory or invalid configurations;
- distinguish company policy from statutory/tax rules;
- distinguish bookkeeping automation from professional judgment;
- require accountant/reviewer approval where judgment is material;
- show what remains unresolved before period close.

## System-wide Saudi accounting compliance gap register

### P0 — Company Accounting & Tax Profile

Required company-scoped accounting profile, including at minimum:

- applicable accounting framework/policy basis;
- fiscal year and reporting period settings;
- functional/reporting currency;
- VAT registration status and effective dates;
- VAT return frequency where applicable;
- Zakat profile;
- income-tax applicability where relevant;
- non-Saudi ownership / mixed ownership indicators where relevant;
- withholding-tax applicability profile;
- effective dates and audit history for policy changes.

E-invoicing/Fatoora is explicitly deferred from the current implementation roadmap and may be reconsidered later if EQFAL needs to issue invoices directly.

The system must not assume every Saudi company has the same tax profile.

### P0 — Fixed Assets Depreciation Policy

Fixed Assets V1 remains functionally open until depreciation-policy governance is completed.

Per asset category, EQFAL should support a controlled policy including:

- depreciation method;
- annual depreciation rate and/or useful life, with a consistent relationship;
- residual value policy;
- depreciation start basis, normally linked to when the asset is available/ready for use;
- asset account;
- accumulated depreciation account;
- depreciation expense account;
- non-depreciable categories such as land;
- policy effective date;
- review/approval status;
- annual review reminder/requirement where applicable.

For straight-line depreciation, the UI must prevent contradictory settings such as an annual rate that does not correspond to the selected useful life under the current residual-value assumptions.

The operator should see plain-language guidance rather than being expected to infer accounting consequences.

### P0 — Opening Balance Review

Create a governed opening-balance review process for the first live financial year and later migrations.

It should reconcile opening balances across at least:

- banks;
- receivables/payables and obligations;
- fixed assets and accumulated depreciation;
- partners/equity;
- VAT/tax balances;
- other material assets and liabilities.

Opening balances should be prepared, reviewed, approved, traceable to evidence, and auditable. They should not be treated as an unexplained ordinary journal only.

### P0 — Accruals & Prepayments

EQFAL needs explicit support for:

- accrued expenses;
- prepaid expenses;
- accrued income;
- deferred/unearned income where relevant;
- reversals and recurring schedules where justified;
- period-lock protection;
- evidence, review and approval.

Monthly profitability is not reliable if material accruals and prepayments are omitted.

### P0 — Monthly Close Completeness

Monthly Close must become the central accounting-completeness gate.

In addition to existing blockers, the design must evaluate relevant unresolved items such as:

- unposted required depreciation;
- unresolved document-backed asset capitalization drafts;
- incomplete VAT review;
- unmatched bank transactions where material/relevant;
- unconfirmed obligations;
- missing or unresolved documents;
- required accruals/prepayments not completed;
- opening-balance review status during transition periods;
- other accounting adjustments that are configured as close requirements.

Closed periods must remain protected. Reopen requires a separate capability, reason, audit trail, and controlled workflow.

### P0 — Financial Statement Mapping

Chart of Accounts alone is not sufficient.

Accounts should be mapped to reporting classifications required to build reliable financial statements, including as applicable:

- current/non-current assets;
- contra-assets;
- current/non-current liabilities;
- equity;
- revenue;
- cost of sales;
- operating expenses;
- other income/expense;
- cash-flow mapping;
- retained earnings / year-end closing treatment.

The mapping should support Balance Sheet / Statement of Financial Position, Profit or Loss, Cash Flows, and Changes in Equity as required by the selected reporting framework.

### P1 — VAT Reconciliation Hardening

Existing VAT foundation already includes treatments such as standard, zero-rated, exempt, and out-of-scope and a closing working paper.

Further work should ensure:

- company VAT registration profile is authoritative;
- tax date logic is explicit and reviewable;
- input/output VAT accounts reconcile to reviewed documents;
- VAT-return period reconciliation exposes differences before filing;
- adjustments/credit notes/debit notes are controlled;
- VAT evidence and review status are retained;
- closed VAT periods are protected;
- reports are working papers for review, not an unreviewed final tax judgment.

### P1 — Zakat / Income Tax Profile

Do not build a single universal "Saudi tax" calculation.

EQFAL should first classify each company correctly and prepare reconciliations/schedules for professional review.

Potential scope:

- Zakat applicability and profile;
- income-tax applicability for relevant ownership/tax cases;
- mixed ownership handling where relevant;
- permanent/temporary tax adjustments only when the policy is formally designed;
- annual working papers and reconciliation package;
- explicit review/approval before any final filing output.

### P1 — Withholding Tax

For relevant payments to non-residents, support a controlled WHT workflow including:

- applicability determination input;
- payee residency/profile;
- payment/service category;
- taxable base and rate;
- due period;
- evidence;
- reconciliation and review;
- accounting posting integration.

Do not apply WHT automatically without a designed policy/rule basis.

### Deferred — E-Invoicing / Fatoora

E-invoicing/Fatoora is not part of the current implementation roadmap.

If EQFAL later needs to issue tax invoices directly, this area must receive a fresh design check against then-current ZATCA requirements, technical integration needs and cost impact before implementation.

Until that need is explicitly approved, no Fatoora integration or invoice-issuance expansion should be introduced merely for completeness.

### P1/P2 — Inventory & Cost of Sales

Inventory is conditional by company activity.

Companies that sell goods or hold material inventory require a controlled inventory/COGS model before their profitability can be considered complete, including as applicable:

- inventory accounts;
- purchases/inventory distinction;
- cost of sales recognition;
- stock counts and adjustments;
- write-down/obsolescence review;
- period close reconciliation.

Do not force this module on service-only companies.

### P2 — Accounting Policies Register

Maintain a company-scoped register of approved accounting policies, including effective dates and reviewer/approver details.

Examples:

- fixed asset depreciation;
- inventory valuation;
- revenue recognition;
- accrual thresholds;
- provisions;
- doubtful debts;
- materiality/close thresholds where appropriate.

### P2 — Year-End Adjustments & Reporting Pack

Year-end workflow should eventually support:

- closing adjustments;
- provisions and reclassifications;
- retained earnings/year-end close;
- tax/zakat working papers;
- financial statement support schedules;
- disclosure/notes support package;
- auditor/accountant evidence pack.

## Implementation priority

Approved priority order:

1. Company Accounting & Tax Profile
2. Fixed Assets Depreciation Policy
3. Opening Balance Review
4. Accruals & Prepayments
5. Monthly Close completeness
6. Financial Statement Mapping
7. VAT reconciliation hardening
8. Zakat / Income Tax / Withholding Tax profiles
9. Inventory/COGS only for companies that require it
10. Accounting Policies Register and year-end reporting pack
11. E-Invoicing/Fatoora only if explicitly approved as a future need

## Delivery governance

For each accounting/compliance capability:

1. Perform a Read-only Design Check first.
2. Identify what is deterministic, what is company policy, and what requires professional judgment.
3. Confirm interaction with tenant isolation, permissions, audit, period locking, Monthly Close and reporting.
4. Avoid coding until the design is approved.
5. Use one bounded implementation task/PR at a time.
6. Validate actual GitHub diff and CI before merge.
7. Perform Practical Validation for material accounting workflows before closing the capability.

## Product acceptance principle

A feature is not complete merely because the UI and API work.

For accounting functionality, acceptance requires all three:

- technical correctness;
- accounting/process coherence;
- controlled review and close behavior appropriate for Saudi company use.

If a competent accountant could reasonably identify a material missing accounting step in an ordinary supported workflow, that gap must be recorded and assessed before EQFAL is described as functionally complete.
