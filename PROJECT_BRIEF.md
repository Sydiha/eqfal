# PROJECT_BRIEF

## اسم المشروع
إقفال | EQFAL — منصة الإدارة والإقفال المالي

## الهدف
بناء نظام ويب مالي داخلي متعدد الشركات، ثنائي اللغة، Mobile First، يساعد الإدارة والمحاسب على جمع الواقع التشغيلي والمستندات والحركات وربطها ومراجعتها ثم الإقفال وتجهيز مخرجات القوائم والزكاة وVAT تدريجيًا.

## Authority

Current merged project state is determined by:

`GitHub/main → AGENTS.md → docs/WORKFLOW_GOVERNANCE.md → docs/TOOLING_RECOVERY_PLAYBOOK.md → docs/EXECUTION_ROADMAP.md → TODO.md → Historical records`

- `GitHub/main` هو المرجع الدائم والوحيد للكود والحالة المدمجة.
- Session/workspace/conversation state ليس durable authority.
- Historical records لا تتغلب على الحالة الحالية أو القواعد الأعلى.
- material unresolved ambiguity تتطلب Owner Approval وفق الحوكمة (`AGENTS.md`).

## Current Project State

Reference SHA at time of reconciliation — not current HEAD:
`181f37ed60920cdf406155049173a9924272c0bb`

Reconciliation date:
`2026-10-03`

هذا SHA audit/reconciliation reference فقط، وليس ضمانًا بأنه سيظل current HEAD مستقبلًا.

EQFAL تجاوز مرحلة تأسيس النواة. التنفيذ المدمج على `main` يشمل foundations/workflows فعلية للمصادقة والعزل والصلاحيات وFiscal Years وDocuments وBanking وPartners وObligations وAccounting Ledger وSales وPurchases وFixed Assets وOpening Balances وPeriodic Adjustments وVAT وMonthly Close وAnnual Closing readiness.

### Reconciled roadmap status

- Phase 1 — Company Accounting & Tax Profile: **DONE**
- Phase 2 — Fixed Asset Depreciation Policy: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 3 — Opening Balance Review: **DONE**
- Phase 4 — Accruals / Prepayments / Periodic Adjustments: **DONE**
- Phase 5 — Financial Statement Mapping: **DONE**
- Phase 6 — VAT Reconciliation Hardening: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 7 — Zakat / Income Tax / Withholding Tax: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 8 — Integrated Monthly Close: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 9 — Final Permission Model: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 10 — Company Manager Workspace: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 11 — Home Screen Alerts: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 12 — Manager Financial Snapshot: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 13 — Conditional Modules: **CONDITIONAL / DEFERRED**
- Phase 14 — Full Operational & Accounting Cycle Validation: **IN PROGRESS / PARTIALLY VALIDATED** (14A merged; 14B in validation — see `docs/EXECUTION_ROADMAP.md`)
- Phase 15 — System-wide UI/UX Redesign: **PARTIALLY MERGED / IN PROGRESS**

VAT is complete only for the approved current scope.

Product work continues per `docs/EXECUTION_ROADMAP.md` (Phase 14 validation in progress; Phase 15 partially merged).

## Autonomous Operating Model — SUPERSEDED

**SUPERSEDED — current governance is defined by AGENTS.md.**

The Autonomous Operating Model (EQFAL Project as Product Owner/Lead PM; Orchestrator; Builder Role; Independent Reviewer; Automated Merge Gate; routine user approvals superseded) is kept only as project history in `DECISIONS.md` (2026-09-11). It is not an active instruction. Under current governance, `AGENTS.md` is the governing source: the workflow is owner-controlled, there is no autonomous or multi-agent workflow, and there is no automatic merge.

## Design and Merge Policy

Governed by `AGENTS.md`:

- Every Product task starts with Read-only Design Check, then Plan.
- Owner Approval is required before coding; Codex Cloud is only a bounded Coding Engine after the pre-coding gates pass.
- Workflow: READ-ONLY → PLAN → OWNER APPROVAL → CODEX PREFLIGHT → CODEX EXECUTION → EQFAL REVIEW → TESTS / CI → GITHUB HANDOFF → REPLIT SAME-SHA VALIDATION → OWNER UAT → OWNER MERGE DECISION.
- Only the Owner makes the final merge decision; no automatic merge, and CI passing alone is not merge approval.
- The Execution Contract includes baseline SHA, goal, scope, out-of-scope, affected boundaries, schema/migrations if applicable, acceptance criteria, tests, required Owner Approvals, and Definition of Done.

## Owner Approval Required (formerly 'Human Gates')

`HUMAN DECISION REQUIRED` is reserved for:
- Production deployment/change;
- new paid service/API/infrastructure/credits/plan;
- destructive action on real data;
- material accounting/tax policy change not already approved;
- secrets/credentials;
- material unresolved requirement ambiguity;
- sensitive real-user access changes involving Administrator-level access, cross-company expansion, approve/post/reopen/user-administration privileges, or real-user credentials/secrets;
- exceptional Git recovery such as force-push/history rewrite/destructive repository recovery.

Developing permission features inside the approved roadmap does not by itself require a separate Owner Approval beyond the normal workflow.

## User Communication States

- `NO ACTION REQUIRED` — no Owner action is pending.
- `SYNC ASSISTANCE REQUIRED` — temporary Replit-only operational sync assistance; not approval/acceptance/Human Decision.
- `HUMAN DECISION REQUIRED` — explicit Owner Approval required.
- `USER VALIDATION REQUIRED` — practical validation after a Phase or meaningful testable increment, with exact steps and expected result.

The project owner is the final authority for merge and high-risk decisions, but routine Git/branch/PR/CI execution should be handled by the implementation workflow whenever safely permitted.


## Replit Current State

**Replit Sync PoC: PASS WITH HUMAN ACTION**.

Proven:
- GitHub/main synchronized successfully to Replit;
- verified PoC SHA: `2644c9fde0062221240409d47795ae2ee0d022e3`;
- Preview startup: **PASS**.

Not proven:
- full autonomous GitHub → Replit sync;
- runtime SHA verification from the running application.

Replit remains runtime/practical validation only. **Replit Agent is prohibited in all circumstances** (no FREE MODE exception; see `DECISIONS.md` 2026-09-20 and `AGENTS.md`); only manual Replit Shell may be used for approved synchronization, Git-state checks, startup, Preview/basic smoke checks, runtime validation, and same-SHA verification.

## Cloud Codex / Tooling Recovery

Permanent principle:

**GitHub = durable project state. Codex session = disposable executor.**

Normal Coding Engine recovery:

`Cloud Codex → one bounded tooling retry → fresh Cloud Codex session from verified GitHub state → approved Local Codex/fallback when applicable → STOP or Owner Approval only when required`

No infinite retry loops, automatic paid credits, rebuilding valid durable work, or claims that session-local work is durable.

## مبادئ حاكمة

- لا اعتماد على Workspace مؤقت أو ذاكرة المحادثة كمصدر دائم للحالة.
- لا Production دون Owner Approval صريح.
- لا خدمة/API/Credits/ترقية/تكلفة جديدة دون Owner Approval صريح.
- مهمة برمجية واحدة فقط في كل مرة.
- أقل تعديل ممكن يحقق Execution Contract مع اختبارات قابلة للتحقق.
- قابلية النقل خارج Replit شرط معماري دائم.
- عزل الشركات والصلاحيات والأمان لا تؤجل إلى نهاية المشروع.
- UI/API وحدها لا تثبت اكتمالًا محاسبيًا.
- القوائم والزكاة والضرائب الحساسة لا تستبدل الحكم المهني للمحاسب/المستشار المخول.

## Agent Readiness Sequence — SUPERSEDED

**SUPERSEDED — current governance is defined by AGENTS.md.** The former sequence (Orchestrator, Builder Role, Independent Reviewer, Autonomous Agent PoC) is not a current plan; `AGENTS.md` prohibits an autonomous or multi-agent workflow. History is kept in `DECISIONS.md`.
