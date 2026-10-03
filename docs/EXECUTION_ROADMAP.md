# EQFAL — Approved Execution Roadmap

Status: Approved project guidance
Reconciliation date: 2026-10-03

Last reconciled against GitHub/main SHA:
`181f37ed60920cdf406155049173a9924272c0bb`

This SHA is an audit/reconciliation baseline only; it does not guarantee future `main` HEAD.

## Authority

`GitHub/main → AGENTS.md → docs/WORKFLOW_GOVERNANCE.md → docs/TOOLING_RECOVERY_PLAYBOOK.md → docs/EXECUTION_ROADMAP.md → TODO.md → Historical records`

This document is authoritative for product roadmap/status below the higher governance sources. Historical phase recaps or old TODO entries must not override it.

## Permanent Delivery Rules

- GitHub `main` is the sole source of truth for merged project state.
- One bounded programming task at a time.
- Approved Execution Contracts are binding.
- One corrective implementation pass maximum for a real code/acceptance blocker; tooling failures follow the recovery playbook and do not create extra code-fix loops.
- No Production change without Human Gate.
- No paid service/API/credits/plan/infrastructure/operating cost without Human Gate.
- System-wide UI/UX redesign (Phase 15) is PARTIALLY MERGED / IN PROGRESS and proceeds in parallel with Phase 14 validation; see the Phase 15 section.
- The owner/operator is treated as a non-accountant; EQFAL must not require unexplained professional accounting/tax judgments from the user.
- Roles are templates; effective capabilities are authoritative and company-scoped; Backend authorization remains authoritative.
- Sensitive changes require auditability and controlled effective dates where relevant.

## Replit — Current Proven State

**Replit Sync PoC: PASS WITH HUMAN ACTION**.

Proven:
- GitHub/main synchronized successfully to Replit during the PoC.
- Verified SHA during PoC: `2644c9fde0062221240409d47795ae2ee0d022e3` (historical PoC evidence only; not a current baseline).
- Preview startup: **PASS**.

Not yet proven:
- full autonomous GitHub → Replit synchronization;
- runtime SHA verification from the running application.

Until both are proven, Replit remains runtime/practical validation only. A small user sync action may use `SYNC ASSISTANCE REQUIRED`; it is not approval or User Acceptance.

**Current binding policy:** Replit Agent is prohibited in all circumstances across EQFAL. There is no FREE MODE exception. Replit may be used only through **manual Replit Shell** for approved synchronization, Git-state checks, startup, Preview/basic smoke checks, runtime validation, and same-SHA verification. Replit Shell must not be used to bypass GitHub governance, recreate Product changes, rescue PRs, or perform unapproved Product coding.

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

**Status: DONE FOR CURRENTLY APPROVED SCOPE**

Reconciliation against `GitHub/main` SHA `14846d39f85e2718677071705e762bc1dd21e789` confirmed the merged Phase 7 foundations from PRs #211, #213, #272, and #274.

Implemented scope includes:
- governed tax/Zakat working papers tied to posted financial source data, with reconciliation/source fingerprints, drift detection, governed adjustments, review/approval workflow, and professional-review flags;
- fiscal-year-scoped Annual Closing Packages with lifecycle controls, immutable snapshots, finalization/readiness gates, and accountant handoff metadata;
- tenant-scoped WHT review workflow with granular capabilities, conservative professional-review semantics, and Annual Closing readiness integration;
- explicit package review and approval lifecycle with capability enforcement, source-drift protection, and auditability;
- approved Company Accounting Profile context through `tax_treatment`, `ownership_context`, `wht_profile`, and `has_non_resident_dealings`.

This scope does not automate tax filing, tax calculation, rate/treaty/liability determination, or replace professional tax judgment. Future expansion requires a new Read-only Design Check.

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

**Status: DONE FOR CURRENTLY APPROVED SCOPE**

Implemented scope includes capability-aware Home Alerts; current-user, upcoming, waiting-for-accountant, and waiting-for-team ownership classification; backend-authoritative ownership; module visibility boundaries; preserved drill-through; and a Monthly Close readiness/blocker summary with capability-safe disclosure. Future alert expansion requires a new Read-only Design Check.

## Phase 12 — Manager Financial Snapshot

**Status: DONE FOR CURRENTLY APPROVED SCOPE**

The merged Phase 12A operational management view includes:
- bank balances only when a trusted available running balance exists;
- amounts to collect;
- amounts to pay;
- current-month approved sales;
- current-month approved purchases/expenses;
- tenant- and capability-aware disclosure with explicit unavailable and hidden states.

This is an operational management view, not financial statements or a profitability measure. It does not imply profit, margin, EBITDA, forecasting, or AI scope. Future expansion requires a new Read-only Design Check.

## Phase 13 — Conditional Modules

**Status: CONDITIONAL / DEFERRED**

Implement only when a company genuinely needs them and after applicable Design/Human Gates:
- inventory / COGS / stock counts and adjustments;
- e-invoicing / ZATCA Fatoora;
- advanced external integrations;
- paid OCR/AI/messaging services.

Any cost-bearing capability requires a Human Gate before cost is introduced.

## Phase 14 — Full-Cycle Validation Matrix & Execution Contract

**Status: IN PROGRESS / PARTIALLY VALIDATED**

Substages:

- **14A: Validation Matrix Design**
  - Status: ✅ MERGED (2026-09-20)
  - PRs: #283, #285
  - Deliverable: `docs/PHASE_14_FULL_CYCLE_VALIDATION_MATRIX.md`
- **14B: Foundation & Master Data Validation**
  - Status: ✅ PASS — Issue #286 (2026-09-20)
  - Progress: Steps 1–5 PASS (evidence in GitHub Issue #286 comments; recorded in `docs/PHASE_14_FULL_CYCLE_VALIDATION_MATRIX.md` via PR #320)
    - Company context
    - Accounting & Tax Profile
    - Fiscal Year 2026
    - Opening Balances
    - Customers / Suppliers (Partners)

Validation Fixes by Slice:

The following PRs resulted from Phase 14 validation and are now merged back to main. Slice attribution follows the label in each PR's GitHub description/title/branch.

14C — Purchase/Payment/Banking Cycle:

- (none yet)

14D — Sales/Collection Cycle:

- (none yet)

14E — Assets/Adjustments/VAT:

- #287: Purchase-to-asset navigation (PR description: "Phase 14E-2 blocker")
- #288: Future asset depreciation guard (PR description: "Phase 14E-2 control gap")
- #289: Periodic adjustment future-posting guard (labeled 14E-3A)
- #290: Manual journal future-posting guard (labeled 14E-5A)

14F — Ledger/Monthly Close/Financial Statements:

- (none yet)

14G — Tax/WHT/Annual Closing:

- #291: Tax workpaper source-drift approval guard (labeled 14E-9A)
- #292: Source-drift blocker (labeled 14E-9B)
- #294: Tax Workpaper Reconcile action (branch `codex/github-mention-14g-expose-tax-workpaper-reconcile-action`)

14H — Cross-cutting closeout:

- (none yet)

Full slice definitions: see `docs/PHASE_14_FULL_CYCLE_VALIDATION_MATRIX.md` §8.

Dependencies: Phase 13 reactivation pending business need and owner gates (independent of Phase 14).

Baseline SHA: `8f17258df221d15919e56487721f7d087d0a77e9` (14A design baseline)
Reference SHA at time of reconciliation — not current HEAD: `181f37ed60920cdf406155049173a9924272c0bb` (80+ commits ahead of the 14A doc commit)

## Phase 15 — System-wide UI/UX Redesign

**Status: PARTIALLY MERGED / IN PROGRESS**

Merged Components:

- #305: Sales visual redesign (✅ MERGED 2026-09-30)
- #309: Home financial overview (✅ MERGED 2026-10-01)
- #313: Home blocker categories fix (✅ MERGED 2026-10-02)

Open Work:

- #307: Purchases visual redesign (🔄 OPEN — unique work stream, not blocked by Phase 14)

Pending:

- Remaining system-wide UI/UX components (NOT YET STARTED)

Note: Phase 15 work progresses in parallel with Phase 14; not dependent on Phase 14 completion.

## Governance Model

Source of truth: `AGENTS.md`

Key Constraints:

- Owner-controlled workflow (no autonomous agents)
- No automatic merge
- Owner approval required before coding
- Owner-only merge decision authority

Workflow (Summary):

`READ-ONLY → PLAN → OWNER APPROVAL → CODEX PREFLIGHT → CODEX EXECUTION → EQFAL REVIEW → TESTS/CI → GITHUB HANDOFF → REPLIT SAME-SHA VALIDATION → OWNER UAT → OWNER MERGE DECISION`

See `AGENTS.md` for full governance and role definitions.

## Cost-Control Rule

Existing application/PostgreSQL infrastructure should be used wherever practical. New paid services, APIs, credits, runners, servers, databases, storage, OCR, messaging, or other recurring costs require a Human Gate.

## Current Architecture / Execution Sequence

### Product Track

1. Resume Product roadmap from actual dependencies/current `main`.
2. Phase 2, Phase 5, Phase 7, Phase 8, Phase 9, Phase 10, Phase 11, and Phase 12 are **DONE for their currently approved scopes**; do not recreate or reimplement those completed foundations without a new approved gap.
3. Phase 14 (Full-Cycle Validation) is IN PROGRESS / PARTIALLY VALIDATED; Phase 15 (UI/UX) is PARTIALLY MERGED / IN PROGRESS. See the Phase 14, Phase 15, and Governance Model sections above.
4. Every Product task follows the workflow in the Governance Model section above, as defined in `AGENTS.md`.
5. Keep Phase 13 deferred until its explicit gates are met.
