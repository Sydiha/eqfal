# EQFAL — Approved Execution Roadmap

Status: Approved project guidance
Reconciliation date: 2026-09-18

Last reconciled against GitHub/main SHA:
`ff7fa41b544037a30b5cc00ac3869e22d400526b`

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

No Full Autonomous readiness is claimed until event-driven automatic continuation is actually operationally proven.

## Product Track / Agent Infrastructure Track Separation

The approved Architecture Decision in `docs/ARCHITECTURE_DECISION_PRODUCT_AGENT_TRACKS.md` separates work into two independent tracks:

- **Product Track** continues the approved Product roadmap from current dependencies.
- **Agent Infrastructure Track** continues autonomous-execution infrastructure work.

The unresolved **Automatic Continuation Gap blocks Full Autonomous Readiness only**. It does **not** block Product roadmap execution, including Phase 5, when the normal Product Design/Execution/Review/CI/Merge/Validation gates can be satisfied.

The two tracks may progress independently. Agent Infrastructure work must not silently change Product scope or roadmap priority, and Product work must not be represented as proof that Full Autonomous continuation is operational.

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

**Current binding policy:** Replit Agent is prohibited in all circumstances across EQFAL. There is no FREE MODE exception. Replit may be used only through **manual Replit Shell** for approved synchronization, Git-state checks, startup, Preview/basic smoke checks, runtime validation, and same-SHA verification. Replit Shell must not be used to bypass GitHub governance, recreate Product changes, rescue PRs, or perform unapproved Product coding.

## Agent Readiness Status

- Governance Reconciliation documentation: **DONE**.
- Replit Sync PoC: **PASS WITH HUMAN ACTION**.
- Orchestrator deterministic core: **PROVEN for the implemented scope**.
- Durable delivery through Connector Publisher: **PROVEN**.
- Independent Review + exact-SHA CI + Merge Gate + merge + Replit runtime validation path: **PROVEN through PR #188**.
- Automatic/event-driven continuation: **NOT OPERATIONALLY PROVEN**.
- Full Autonomous Readiness: **NOT READY — blocked by Automatic Continuation Gap**.

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

**Status: DONE FOR CURRENTLY APPROVED SCOPE**

Read-only closure reconciliation against `GitHub/main` SHA `14c9bc025193a74bc4a4ea7055d15a5a40fedea9` confirmed that the approved Phase 2 scope is implemented and operationally surfaced.

Implemented scope includes:
- governed category-level depreciation policy versions with effective dating and immutable legacy snapshots;
- draft, review, approval, and supersession lifecycle with audit logging;
- depreciation-method, useful-life, residual-value, depreciation-start, and account-mapping consistency validation;
- asset binding to the applicable depreciation-policy version;
- prospective active-asset estimate-change workflow for remaining useful life and residual value;
- first-day-of-month effective dates, accounting-period lock protection, and protection of already posted depreciation;
- prospective schedule rebuilding only, without retrospective restatement of posted depreciation;
- policy-exception detection and mandatory reason capture where the asset estimate departs from the governed category policy;
- operational UI for current policy, policy history, policy draft/review/approval, bound policy-version visibility, and estimate-change history/workflow.

Advanced impairment, revaluation, components, multiple books, tax depreciation, active-asset depreciation-method changes, retrospective restatement, advanced proration, and similar advanced features remain deferred until proven necessary and require a new Read-only Design Check.

## Phase 3 — Opening Balance Review

**Status: DONE**

Governed opening-balance review and traceability/correction foundations are implemented for the currently approved scope, including controlled review/approval and source traceability.

## Phase 4 — Accruals, Prepayments and Periodic Adjustments

**Status: DONE**

Accrual/prepayment/deferred/periodic-adjustment workflow foundation is implemented with schedules, review/approval behavior, posting integration, period locking, and Monthly Close integration for the approved scope.

## Phase 5 — Chart Classification and Financial Statement Mapping

**Status: DONE**

Read-only completeness reconciliation against `GitHub/main` SHA `212d6b94b40a8d0c8bcb1ee7d0c16380e8e360ca` confirmed that the approved Phase 5 scope is implemented and covered by dedicated tests.

Implemented scope includes:
- account classification for current/non-current assets, contra-assets, current/non-current liabilities, equity, revenue, cost of sales, operating expenses, finance income/expense, and other income/expense;
- explicit financial-statement mapping with fail-closed `unmapped` semantics;
- Statement of Financial Position;
- Profit or Loss;
- Statement of Changes in Equity;
- Statement of Cash Flows with explicit operating/investing/financing classification and reconciliation;
- reports derived from posted ledger/journal data rather than independent manual figures;
- tenant-scoped reads/writes, capability enforcement, and audit logging for classification changes;
- blocking of financial-statement output when material posted activity remains unmapped or cash-flow classification is ambiguous.

Any future expansion beyond this implemented scope requires a new Read-only Design Check.

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

**Status: DONE FOR CURRENTLY APPROVED SCOPE**

Read-only closure reconciliation against `GitHub/main` SHA `5766d58154fce89f6908a056bf9f62cf6e105537` confirmed that the approved Phase 8 scope is implemented and covered by focused automated tests.

Implemented scope includes:
- governed monthly close periods with period-boundary validation, overlap prevention, close locking, reopen controls, mandatory reopen reasons, and audit logging;
- authoritative backend close enforcement that recomputes blockers at close time rather than trusting UI state;
- blocker coverage for incomplete/unreviewed documents, unconfirmed obligations, unmatched/unresolved bank transactions, VAT readiness, unposted operational/accounting sources, independent draft journals, required depreciation/document-backed asset drafts, periodic adjustments, and applicable opening-balance review;
- dedicated periodic-adjustment and opening-balance blockers without double counting them into generic ledger blockers;
- company-profile-aware VAT applicability, including fail-closed behavior when applicability remains unresolved;
- transition-year opening-balance applicability derived from the approved Company Accounting & Tax Profile and `first_live_accounting_date`;
- capability-aware blocker disclosure that hides unauthorized categories/counts while preserving authoritative hidden-blocker readiness;
- period-scoped drill-through/navigation to the relevant operational workspace for disclosed blockers;
- tenant/company scoping, close/reopen capability enforcement, and closed-period coordination.

No separate user-configurable close-requirements framework is required by the currently approved scope. Future expansion beyond the deterministic blocker/applicability model above requires a new Read-only Design Check.

## Phase 9 — Final Permission Model

**Status: DONE FOR CURRENTLY APPROVED SCOPE**

Read-only closure reconciliation against `GitHub/main` SHA `116dc676772b20220e7b77704bafe9f1a0d3c243` confirmed that the approved Phase 9 permission-model scope is implemented.

Implemented scope includes:
- company-scoped capability-based backend authorization across the reviewed operational domains;
- granular separation of view/create/edit/review/approve/post/cancel/reopen/policy actions where applicable;
- granular Access Administration capabilities for view, membership creation/status changes, role assignment, role creation, and capability grant/revoke;
- legacy broad capabilities retained only for historical/backfill compatibility where applicable, without runtime fallback for completed granularity migrations;
- Grant Ceiling enforcement that prevents assigning capabilities beyond the acting user's effective authority;
- Full Access assignment protection;
- protection against self-escalation beyond the actor's current authority;
- server-trusted active-company scoping and cross-company access protections;
- same-origin protection for sensitive access-administration writes;
- permanent transactional Audit Trail coverage for access-administration mutations.

Post-merge runtime validation on Replit confirmed Frontend HTTP 200, API HTTP 200, and database status `connected` on the same merged baseline.

Future permission-model expansion beyond this implemented scope requires a new Read-only Design Check.

## Phase 10 — Company Manager Workspace

**Status: DONE FOR CURRENTLY APPROVED SCOPE**

Read-only closure reconciliation against `GitHub/main` SHA `ff7fa41b544037a30b5cc00ac3869e22d400526b` confirmed that the approved Phase 10 manager-workspace scope is implemented.

Implemented scope includes:
- manager-facing operational navigation across purchases, sales, documents, banking, obligations, partners, assets, and Monthly Close visibility;
- direct daily operational entry for sales, purchases, and expenses without requiring accounting mechanics;
- capability-aware navigation and action visibility;
- operational-entry actions exposed only when the required document/obligation capability set is present;
- document upload retained as a distinct capability-governed action;
- accounting review/approval mechanics remain separated from the manager's operational-entry experience.

Phase 10 Closure Audit is **PASS** for the currently approved scope. Future expansion of the Company Manager Workspace requires a new Read-only Design Check.

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

Two independent tracks are active:

### Product Track

1. Resume Product roadmap from actual dependencies/current `main`.
2. Phase 2, Phase 5, Phase 8, and Phase 9 are **DONE for their currently approved scopes**; do not recreate or reimplement those completed foundations without a new approved gap.
3. Select the next Product task from the remaining PARTIAL / NOT STARTED roadmap items using current dependencies and a dedicated Read-only Design Check.
4. Every Product task follows Read-only Design Check → Execution Contract → Builder → durable GitHub delivery → Independent Reviewer → exact-SHA CI → Merge Gate → merge → Replit/runtime validation.
5. Keep Phase 13 and Phase 15 deferred until their explicit gates are met.

### Agent Infrastructure Track

1. Continue resolving the **Automatic Continuation Gap** independently of Product work.
2. Hourly watchdog remains recovery/watchdog only and is not the primary execution driver.
3. Do not claim Full Autonomous Readiness until event-driven continuation is operationally proven with durable execution evidence.

Product work does not wait for Full Autonomous Readiness, and continuing Product work does not by itself prove Full Autonomous operation.
