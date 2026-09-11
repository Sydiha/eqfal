# EQFAL — Approved Execution Roadmap

Status: Approved project guidance
Reconciliation date: 2026-09-11

Last reconciled against GitHub/main SHA:
`2644c9fde0062221240409d47795ae2ee0d022e3`

This SHA is an audit/reconciliation baseline only; it does not guarantee future `main` HEAD.

## Authority

`GitHub/main → AGENTS.md → docs/WORKFLOW_GOVERNANCE.md → docs/TOOLING_RECOVERY_PLAYBOOK.md → docs/EXECUTION_ROADMAP.md → TODO.md → Historical records`

This document is authoritative for product roadmap/status below the higher governance sources. Historical phase recaps or old TODO entries must not override it.

## Autonomous Operating Model Context

After the Autonomous Operating Model governance package is merged to `main`:

- **EQFAL Project = Product Owner + Lead PM + Roadmap Authority** and selects the next task from current `main`, this roadmap, and dependency order.
- Every Product task begins with a Read-only Design Check.
- EQFAL Project may internally approve a Design Check when it is inside the approved roadmap/direct dependency and no Human Gate applies.
- Orchestrator manages execution lifecycle but cannot change product scope/roadmap.
- Builder is a role; Cloud Codex is the primary Builder execution engine.
- Independent Reviewer checks the actual GitHub diff against the approved Execution Contract.
- Merge may be automatic only through the complete Merge Gate in `docs/WORKFLOW_GOVERNANCE.md`.
- Routine user Design Approval and routine user Merge Approval are superseded after this governance is merged.
- Production, paid cost, destructive real-data actions, material accounting/tax policy changes, secrets/credentials, specified sensitive real-user access changes, material unresolved ambiguity, and exceptional Git recovery remain Human Gates.

No Autonomous Agent readiness is claimed until the Orchestrator, Builder-role integration, Independent Reviewer, and end-to-end Autonomous Agent PoC are actually built and verified.

## Permanent Delivery Rules

- GitHub `main` is the sole source of truth for merged project state.
- One bounded programming task at a time.
- Approved Execution Contracts are binding.
- One corrective implementation pass maximum for a real code/acceptance blocker; tooling failures follow the recovery playbook and do not create extra code-fix loops.
- No Production change without Human Gate.
- No paid service/API/credits/plan/infrastructure/operating cost without Human Gate.
- Complete the system functionally/accounting-wise before system-wide UI/UX redesign; earlier UI work is limited to functional/usability blockers.
- The owner/operator is treated as a non-accountant; EQFAL must not require unexplained professional accounting/tax judgments from the user.
- Roles are templates; effective capabilities are authoritative and company-scoped; Backend authorization remains authoritative.
- Sensitive changes require auditability and controlled effective dates where relevant.

## Replit — Current Proven State

**Replit Sync PoC: PASS WITH HUMAN ACTION**.

Proven:
- GitHub/main synchronized successfully to Replit during the PoC.
- Verified SHA during PoC: `2644c9fde0062221240409d47795ae2ee0d022e3`.
- Preview startup: **PASS**.

Not yet proven:
- full autonomous GitHub → Replit synchronization;
- runtime SHA verification from the running application.

Until both are proven, Replit remains runtime/practical validation only. A small user sync action may use `SYNC ASSISTANCE REQUIRED`; it is not approval or User Acceptance.

Replit Agent is allowed only in FREE MODE for synchronization, Git-state checks, startup, Preview/basic smoke/runtime validation, and runtime SHA verification when proven. It remains prohibited for Product coding/refactoring, accounting/tax logic, DB/schema design/migrations, branch reconstruction, PR rescue, patch relay, GitHub push/write/PR, Power, Max, or paid credits/additional paid usage.

## Agent Readiness Status

- Governance Reconciliation documentation: **DONE**.
- Replit Sync PoC: **PASS WITH HUMAN ACTION**.
- Autonomous Operating Model governance package: **CURRENT GOVERNANCE WORK** until merged.
- Orchestrator implementation/readiness: **NOT YET PROVEN**.
- Builder Role + Cloud Codex integration: **NOT YET PROVEN**.
- Independent Reviewer implementation/readiness: **NOT YET PROVEN**.
- Autonomous Agent end-to-end PoC: **NOT YET PROVEN**.

## Phase 0 — Project reference and accounting/compliance governance

**Status: DONE / ONGOING GOVERNANCE**

- Keep Saudi accounting/tax compliance guidance in project documentation.
- Treat owner/manager as a non-accountant operator.
- EQFAL records operational truth, links evidence, applies deterministic controls, surfaces gaps, and routes material professional judgments to authorized accountant/reviewer.
- UI/API success alone does not prove accounting completeness.
- 2026 remains the first live year; historical/opening balances use controlled review.

## Phase 1 — Company Accounting & Tax Profile

**Status: DONE**

Implemented approved foundation includes accounting framework, fiscal/currency context, VAT profile, Zakat/income-tax context, WHT profile, effective dating/workflow metadata, and approved capabilities/workflow. Future expansion requires a new Design Check.

## Phase 2 — Fixed Asset Depreciation Policy

**Status: PARTIAL**

Strong Fixed Assets foundation exists, including categories, useful life/residual value, account links, depreciation schedule/posting integration, opening accumulated depreciation, disposal handling, and close integration.

Remaining gap: complete governed category-level depreciation policy/history/effective-dating/review semantics and approved rate/useful-life consistency requirements not yet represented as a full policy lifecycle.

Advanced impairment, revaluation, components, multiple books, tax depreciation, and similar advanced features remain deferred until proven necessary.

## Phase 3 — Opening Balance Review

**Status: DONE**

Governed opening-balance review and traceability/correction foundations are implemented for the currently approved scope, including controlled review/approval and source traceability.

## Phase 4 — Accruals, Prepayments and Periodic Adjustments

**Status: DONE**

Accrual/prepayment/deferred/periodic-adjustment workflow foundation is implemented with schedules, review/approval behavior, posting integration, period locking, and Monthly Close integration for the approved scope.

## Phase 5 — Chart Classification and Financial Statement Mapping

**Status: NOT STARTED — NEXT REAL PRODUCT GAP after Agent-readiness work**

Required scope remains:
- expand chart classification where necessary: current/non-current assets, contra-assets, current/non-current liabilities, equity, revenue, cost of sales when applicable, operating expenses, finance and other income/expense as needed;
- map accounts to financial-statement presentation;
- Statement of Financial Position;
- Profit or Loss;
- Changes in Equity;
- Cash Flows when prerequisite data is complete;
- derive reports from ledger data rather than independent manual numbers;
- do not present profitability/cash-flow KPIs as final before the accounting cycle is complete.

No implementation starts without a dedicated Read-only Design Check and a valid approval under current governance.

## Phase 6 — VAT Reconciliation Hardening

**Status: DONE FOR CURRENTLY APPROVED SCOPE**

The approved VAT scope includes authoritative company VAT profile behavior, filing-period authority, reconciliation, recoverability review, controlled adjustments/post-period correction lifecycle, return snapshots, and filing records/readiness.

This does not pre-approve future VAT/tax requirements. New tax scope requires a new Design Check and any applicable Human Gate.

## Phase 7 — Zakat, Income Tax and Withholding Tax

**Status: PARTIAL**

Company applicability/profile foundations exist and Annual Closing can surface conservative readiness. Remaining future work includes, subject to approved designs:
- Zakat/tax working papers and reconciliations tied to financial statements;
- ownership/tax treatment context where relevant;
- WHT review/workflows for relevant non-resident payments;
- professional review/approval before final filing outputs.

EQFAL prepares, reconciles, explains, and surfaces exceptions; it does not replace final professional tax judgment.

## Phase 8 — Integrated Monthly Close

**Status: PARTIAL / STRONG FOUNDATION**

A strong implemented foundation exists: monthly periods, blockers, period locking/reopen controls, ledger/VAT/assets/adjustments integration, and closed-period coordination.

Phase 8 remains not finally DONE until a dedicated **Monthly Close Completeness Gap Audit** verifies applicable blocker categories, plain-language resolution semantics, navigation targets, role/capability behavior, company-profile-aware applicability, and reopen reason/audit/capability behavior.

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

Strong capability/company-scoped authorization and Grant Ceiling foundations exist. A completeness review is still required before DONE, including separation of view/create/edit/review/approve/post/cancel/reopen/policy/user-administration capabilities where relevant and audit of permission changes.

Developing permission-model features within this approved roadmap is normal Product work. Human Gate applies only to sensitive access changes affecting real users as defined by governance.

## Phase 10 — Company Manager Workspace

**Status: PARTIAL**

Operational modules exist for purchases, sales, documents, banking, obligations, partners, assets, and close visibility. A coherent manager-facing workspace still requires completion/validation so a non-accountant can record operational reality without accounting mechanics.

## Phase 11 — Home Screen Alerts

**Status: PARTIAL**

Home already surfaces Monthly Close readiness/blockers and drill-through behavior. Remaining scope includes richer current-action, upcoming-due, waiting-for-accountant, and waiting-for-team classification subject to capabilities, without exposing restricted detail.

## Phase 12 — Manager Financial Snapshot

**Status: NOT STARTED**

When underlying data is trustworthy, intended snapshot may include:
- bank balances;
- amounts to collect;
- amounts to pay;
- current-month sales;
- current-month purchases/expenses.

Do not confuse bank balance with profit/liquidity/net financial position, and do not present profit/margin/EBITDA/free-cash-flow as final before the accounting cycle is complete.

## Phase 13 — Conditional Modules

**Status: DEFERRED**

Implement only when a company genuinely needs them and after applicable Design/Human Gates:
- inventory / COGS / stock counts and adjustments;
- e-invoicing / ZATCA Fatoora;
- advanced external integrations;
- paid OCR/AI/messaging services.

Any cost-bearing capability requires a Human Gate before cost is introduced.

## Phase 14 — Full Operational and Accounting Cycle Validation

**Status: NOT STARTED**

Validate a real end-to-end cycle after prerequisite Product gaps are complete:

Company setup → Accounting & Tax Profile → Fiscal year → Opening balances → customers/suppliers → purchase → evidence → payment → sale → collection → expense → obligations → custody → banking/import/matching → fixed asset → depreciation → accruals/prepayments → VAT → journals/adjustments → ledger/trial balance → monthly close → financial statements → applicable Zakat/tax workpapers → year-end close.

Also validate tenant isolation, permissions, audit, duplicate prevention, period locks, numerical correctness, document relationships, tax handling, workflow transitions, and usability for a non-accountant manager.

## Phase 15 — System-wide UI/UX Redesign & Polish

**Status: DEFERRED**

Start only after functional/accounting completion and full-cycle validation. Before that, UI/UX work is limited to functional blockers or defects preventing correct use.

## Cost-Control Rule

Existing application/PostgreSQL infrastructure should be used wherever practical. New paid services, APIs, credits, runners, servers, databases, storage, OCR, messaging, or other recurring costs require a Human Gate.

## Current Architecture / Execution Sequence

This is the active sequence after the Autonomous Operating Model governance package is merged:

1. Build and test **Orchestrator**.
2. Build and test **Builder Role with Cloud Codex as primary execution engine**.
3. Build and test **Independent Reviewer**.
4. Run an **Autonomous Agent PoC** proving task handoff, durable checkpoints, independent review, exact-SHA CI gating, compliant merge control, failure recovery, and user-notification states without bypassing Human Gates.
5. Only after Agent readiness is actually proven, resume the real Product roadmap from current dependencies. The currently identified next real Product gap remains **Phase 5 — Financial Statement Mapping**, while Phase 8 remains PARTIAL pending its dedicated completeness gap audit.
6. Continue later roadmap work from actual dependencies/current `main`, not historical phase numbering alone.
7. Keep Phase 13 and Phase 15 deferred until their explicit gates are met.

Do not claim autonomous operation is ready merely because this governance design exists; readiness requires implementation and evidence.
