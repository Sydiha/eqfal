# EQFAL — Approved Execution Roadmap

Status: Approved project guidance
Reconciliation date: 2026-09-11

Last reconciled against GitHub/main SHA:
`6b1b75382d9cedb9d2b2fb229aa3e9a860cbbc69`

This SHA is an audit/reconciliation baseline only; it is not a guarantee that it remains the current GitHub/main HEAD after later merges.

## Authority

`GitHub/main → AGENTS.md → docs/WORKFLOW_GOVERNANCE.md → docs/TOOLING_RECOVERY_PLAYBOOK.md → docs/EXECUTION_ROADMAP.md → TODO.md → Historical records`

This document is authoritative for product roadmap/status below the higher governance sources. Historical phase recaps or old TODO entries must not override this roadmap. If a material ambiguity remains after applying the hierarchy: STOP + escalate.

## Permanent delivery rules

- GitHub `main` is the sole source of truth for merged project state.
- One bounded programming task at a time.
- Every implementation task begins with a read-only Design Check; no coding before approval.
- After Design Approval, use one complete implementation contract for Codex whenever practical.
- Avoid iterative prompt loops and unnecessary context transfer.
- One corrective implementation pass is allowed for a real code/acceptance blocker. A second corrective pass requires stopping and revisiting the design.
- No Production changes without explicit approval.
- No paid service, new operating cost, paid API, extra credits, plan upgrade, paid runner, extra server/database/storage/OCR/messaging dependency without explicit prior approval.
- Complete the system functionally and accounting-wise before system-wide UI/UX redesign.
- UI/UX work before that point is limited to functional blockers or usability defects that prevent correct operation.
- The project owner/operator is treated as a non-accountant. EQFAL must not require a non-accountant to make unexplained professional accounting/tax judgments.
- Roles are templates; effective capabilities are authoritative and company-scoped. Backend authorization remains authoritative.
- Sensitive changes require auditability and controlled effective dates where relevant.

## Replit Agent — FREE MODE ONLY

Replit Agent may be used only in **FREE MODE** for the approved operational scope, and only subject to successful Replit Sync Proof of Concept. The policy permits this constrained use; it does not claim autonomous/end-to-end sync is already proven.

Allowed only:
- GitHub `main` → Replit sync.
- Git state checks.
- application startup.
- basic smoke tests.
- runtime/latest-approved-main SHA verification.

Prohibited:
- coding/refactoring/feature implementation;
- accounting/tax logic changes;
- DB/schema design or migrations;
- PR rescue/branch reconstruction/patch relay;
- push/write/PR changes to GitHub;
- Power Mode;
- Max Mode;
- paid credits or paid additional usage.

If Free Mode is no longer actually free: **STOP**.

Replit Sync PoC remains an Agent-readiness blocker until proven separately.

## Codex / GitHub delivery model

The current binding delivery lifecycle is defined in `docs/WORKFLOW_GOVERNANCE.md`.

- The managing conversation performs live GitHub baseline reads and records the intended baseline SHA.
- Codex verifies correct repository/checkout, cleanliness, and exact baseline match.
- A normal sandbox `origin`, authenticated sandbox `gh`, or pre-implementation native PR button is not itself a mandatory preflight requirement when the governing checks have otherwise passed.
- PR delivery is evaluated at the Delivery Gate after implementation/tests.
- Real GitHub diff + required CI + Design Check compliance are required for acceptance.
- Tooling failures follow `docs/TOOLING_RECOVERY_PLAYBOOK.md`.

## Phase 0 — Project reference and accounting/compliance governance

**Status: DONE / ONGOING GOVERNANCE**

- Keep Saudi accounting/tax compliance guidance in project documentation.
- Treat the owner/manager as a non-accountant operator.
- EQFAL records operational truth, links evidence, applies deterministic controls, surfaces gaps, and routes material professional judgments to an authorized accountant/reviewer.
- UI/API success alone does not prove accounting completeness.
- 2026 remains the first live year; historical/opening balances are handled through controlled review.

## Phase 1 — Company Accounting & Tax Profile

**Status: DONE**

Implemented current approved foundation includes accounting framework, fiscal/currency context, VAT profile, Zakat/income-tax context, WHT profile, effective dating/workflow metadata, and the approved capabilities/workflow.

Future expansion requires a new Design Check and is not implied by DONE.

## Phase 2 — Fixed Asset Depreciation Policy

**Status: PARTIAL**

Strong Fixed Assets foundation exists, including categories, useful life/residual value, account links, depreciation schedule/posting integration, opening accumulated depreciation, disposal handling, and close integration.

Remaining gap: complete governed category-level depreciation policy/history/effective-dating/review semantics and any approved rate/useful-life consistency requirements not yet represented as a full policy lifecycle.

Advanced impairment, revaluation, components, multiple books, tax depreciation, and similar advanced features remain deferred until proven necessary.

## Phase 3 — Opening Balance Review

**Status: DONE**

Governed opening-balance review and traceability/correction foundations are implemented for the currently approved scope, including controlled review/approval and source traceability.

## Phase 4 — Accruals, Prepayments and Periodic Adjustments

**Status: DONE**

Accrual/prepayment/deferred/periodic-adjustment workflow foundation is implemented with schedules, review/approval behavior, posting integration, period locking and Monthly Close integration for the approved scope.

## Phase 5 — Chart Classification and Financial Statement Mapping

**Status: NOT STARTED — NEXT REAL PRODUCT GAP after Agent-readiness work**

Required scope remains:
- expand chart classification where necessary: current/non-current assets, contra-assets, current/non-current liabilities, equity, revenue, cost of sales when applicable, operating expenses, finance and other income/expense as needed;
- map accounts to financial-statement presentation;
- Statement of Financial Position;
- Profit or Loss;
- Changes in Equity;
- Cash Flows when prerequisite data is complete;
- derive reports from the ledger rather than independent manual numbers;
- do not present profitability/cash-flow KPIs as final before the underlying accounting cycle is complete.

No implementation begins until a dedicated Read-only Design Check is approved.

## Phase 6 — VAT Reconciliation Hardening

**Status: DONE FOR CURRENTLY APPROVED SCOPE**

The currently approved VAT scope includes authoritative company VAT profile behavior, filing-period authority, reconciliation, recoverability review, controlled adjustments/post-period correction lifecycle, return snapshots and filing records/readiness.

This status does **not** close, imply, or pre-approve any future VAT/tax requirement outside the scope already designed and merged. New tax scope requires a fresh Design Check.

## Phase 7 — Zakat, Income Tax and Withholding Tax

**Status: PARTIAL**

Company applicability/profile foundations exist and Annual Closing can surface conservative readiness. The following product work remains subject to future approved designs:
- Zakat/tax working papers and reconciliations tied to financial statements;
- ownership/tax treatment context where relevant;
- WHT review/workflows for relevant non-resident payments;
- professional review/approval before final filing outputs.

EQFAL prepares, reconciles, explains and surfaces exceptions; it does not replace final professional tax judgment.

## Phase 8 — Integrated Monthly Close

**Status: PARTIAL / STRONG FOUNDATION**

A strong implemented foundation exists: monthly periods, blockers, period locking/reopen controls, ledger/VAT/assets/adjustments integration, and closed-period coordination.

This phase is **not considered finally DONE yet**. Before final closure, perform a dedicated **Monthly Close Completeness Gap Audit** against the latest roadmap and verify all applicable blocker categories, plain-language resolution semantics, navigation targets, role/capability behavior, and company-profile-aware applicability.

Expected review areas include, where applicable:
- incomplete/unreviewed documents;
- unconfirmed obligations;
- unmatched/unresolved bank transactions;
- unposted operational/accounting sources;
- independent draft/unposted journals;
- VAT readiness;
- required depreciation and document-backed asset drafts;
- accruals/prepayments and periodic adjustments;
- opening-balance review during transition periods;
- configured close requirements;
- reason/audit/capability behavior for reopen.

## Phase 9 — Final Permission Model

**Status: PARTIAL**

Strong capability/company-scoped authorization and Grant Ceiling foundations exist. A dedicated completeness review is still required before the final permission model is declared DONE, including separation of view/create/edit/review/approve/post/cancel/reopen/policy/user-administration capabilities where relevant and audit of permission changes.

## Phase 10 — Company Manager Workspace

**Status: PARTIAL**

Operational modules exist for purchases, sales, documents, banking, obligations, partners, assets and close visibility. A coherent manager-facing workspace still requires completion/validation so a non-accountant can record operational reality without accounting mechanics.

## Phase 11 — Home Screen Alerts

**Status: PARTIAL**

Home already surfaces Monthly Close readiness/blockers and drill-through behavior. Remaining scope includes richer current-action, upcoming-due, waiting-for-accountant and waiting-for-team classification subject to capabilities, without exposing restricted detail.

## Phase 12 — Manager Financial Snapshot

**Status: NOT STARTED**

When underlying data is trustworthy, the intended snapshot may include:
- bank balances;
- amounts to collect;
- amounts to pay;
- current-month sales;
- current-month purchases/expenses.

Do not confuse bank balance with profit/liquidity/net financial position, and do not present profit/margin/EBITDA/free-cash-flow as final before the accounting cycle is complete.

## Phase 13 — Conditional Modules

**Status: DEFERRED**

Implement only when a company genuinely needs them and after separate approval:
- inventory / COGS / stock counts and adjustments;
- e-invoicing / ZATCA Fatoora;
- advanced external integrations;
- paid OCR/AI/messaging services.

Before any cost-bearing conditional capability, document need and cost impact and obtain explicit approval.

## Phase 14 — Full Operational and Accounting Cycle Validation

**Status: NOT STARTED**

Validate a real end-to-end cycle after prerequisite product gaps are complete:

Company setup → Accounting & Tax Profile → Fiscal year → Opening balances → customers/suppliers → purchase → evidence → payment → sale → collection → expense → obligations → custody → banking/import/matching → fixed asset → depreciation → accruals/prepayments → VAT → journals/adjustments → ledger/trial balance → monthly close → financial statements → applicable Zakat/tax workpapers → year-end close.

Also validate tenant isolation, permissions, audit, duplicate prevention, period locks, numerical correctness, document relationships, tax handling, workflow transitions and usability for a non-accountant manager.

## Phase 15 — System-wide UI/UX Redesign & Polish

**Status: DEFERRED**

Start only after functional/accounting completion and full-cycle validation. Until then, UI/UX work is limited to functional blockers or defects that prevent correct use.

## Cost-control rule

The accounting/profile/policy/permission/alert logic should use existing PostgreSQL/application infrastructure and should not itself require new recurring cost. Potential future cost drivers such as document storage volume and optional external integrations/services require separate approval.

## Current execution order

This order supersedes the older sequence that treated Phase 1 as the next implementation task.

1. Complete Governance Reconciliation and merge the documentation-only governance PR after review/approval.
2. Complete Agent-readiness prerequisites, including the Replit Sync Proof of Concept under FREE MODE ONLY and cleanup/readiness audits as separately approved.
3. Perform the dedicated **Integrated Monthly Close Completeness Gap Audit**; Phase 8 remains PARTIAL / STRONG FOUNDATION until that audit is accepted.
4. Re-run Agent Readiness for the proposed Orchestrator / Builder / Reviewer architecture.
5. Once Agent readiness is established, begin a dedicated Read-only Design Check for the **NEXT REAL PRODUCT GAP: Phase 5 — Financial Statement Mapping**.
6. Continue later roadmap work based on actual dependencies and current GitHub/main state, not historical phase numbering alone.
7. Keep Phase 13 and Phase 15 deferred until their explicit gates are met.
