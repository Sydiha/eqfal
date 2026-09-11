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
- material unresolved ambiguity تستخدم Human Gate وفق الحوكمة.

## Current Project State

Last reconciled against GitHub/main SHA:
`2644c9fde0062221240409d47795ae2ee0d022e3`

Reconciliation date:
`2026-09-11`

هذا SHA audit/reconciliation baseline فقط، وليس ضمانًا بأنه سيظل current HEAD مستقبلًا.

EQFAL تجاوز مرحلة تأسيس النواة. التنفيذ المدمج على `main` يشمل foundations/workflows فعلية للمصادقة والعزل والصلاحيات وFiscal Years وDocuments وBanking وPartners وObligations وAccounting Ledger وSales وPurchases وFixed Assets وOpening Balances وPeriodic Adjustments وVAT وMonthly Close وAnnual Closing readiness.

### Reconciled roadmap status

- Phase 1 — Company Accounting & Tax Profile: **DONE**
- Phase 2 — Fixed Asset Depreciation Policy: **PARTIAL**
- Phase 3 — Opening Balance Review: **DONE**
- Phase 4 — Accruals / Prepayments / Periodic Adjustments: **DONE**
- Phase 5 — Financial Statement Mapping: **NOT STARTED**
- Phase 6 — VAT Reconciliation Hardening: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 7 — Zakat / Income Tax / Withholding Tax: **PARTIAL**
- Phase 8 — Integrated Monthly Close: **PARTIAL / STRONG FOUNDATION**
- Phase 9 — Final Permission Model: **PARTIAL**
- Phase 10 — Company Manager Workspace: **PARTIAL**
- Phase 11 — Home Screen Alerts: **PARTIAL**
- Phase 12 — Manager Financial Snapshot: **NOT STARTED**
- Phase 13 — Conditional Modules: **DEFERRED**
- Phase 14 — Full Operational & Accounting Cycle Validation: **NOT STARTED**
- Phase 15 — System-wide UI/UX Redesign: **DEFERRED**

VAT is complete only for the approved current scope. Monthly Close remains PARTIAL until its dedicated completeness gap audit is accepted.

After Agent-readiness work, the currently identified next real Product gap is **Phase 5 — Financial Statement Mapping**, subject to actual current dependencies when Product work resumes.

## Autonomous Operating Model

After the governance package is merged:

**EQFAL Project = Product Owner + Lead PM + Roadmap Authority**.

It decides **WHAT / WHY / WHEN**, selects the next task from current `main` + roadmap + dependencies, performs Read-only Design Check, may internally approve eligible designs, issues Execution Contracts, and decides Phase completion/Human Gates/User Validation timing. It does not write Product code.

Execution path:

`EQFAL Project → Orchestrator → Builder Role (Cloud Codex primary) → Independent Reviewer → GitHub/CI → Automated Merge Gate → Replit runtime/practical validation → EQFAL Project → user only when required`

### Orchestrator
Execution lifecycle manager only: baseline/preflight, Builder routing, durable checkpoints, failure classification/recovery, Reviewer routing, CI monitoring, Merge Gate, compliant merge, post-merge baseline recording, runtime validation coordination, and evidence return.

It cannot change roadmap/scope/approved contract or bypass Reviewer, CI, or Human Gates.

### Builder Role
Builder is a governance role. Cloud Codex is the primary execution engine. Builder owns clean verified checkout, exact baseline, independent branch, implementation, approved migrations, tests, commit/push/PR. Builder has no design, roadmap, review, merge, Production, or cost authority.

### Independent Reviewer
Reviewer inspects the actual GitHub diff and checks scope/contract compliance plus accounting, tax, tenancy, permissions, audit, schema/migrations, regression, tests, and exact-SHA CI where relevant. Result is `PASS`, `FAIL`, or `NEEDS_CORRECTION`. Builder cannot self-review/self-merge.

## Design and Merge Policy

Every Product task starts with Read-only Design Check.

EQFAL Project may internally approve only when the task is within approved roadmap/direct dependency, current `main` is read, scope is bounded, no material ambiguity/Human Gate exists, and Production/cost/destructive/accounting-tax/security boundaries remain inside approved governance.

The Execution Contract includes baseline SHA, goal, scope, out-of-scope, affected boundaries, schema/migrations if applicable, acceptance criteria, tests, Human Gates, and Definition of Done.

Routine user Design Approval and routine user Merge Approval are superseded after this governance is merged. Design self-approval never means implementation self-approval.

Automatic merge requires the complete Merge Gate in `docs/WORKFLOW_GOVERNANCE.md`, including an actual PR, correct lineage, scope compliance, Independent Reviewer `PASS`, required CI `PASS` on the exact intended PR head SHA, no unresolved blocker, and no Human Gate.

## Human Gates

`HUMAN DECISION REQUIRED` is reserved for:
- Production deployment/change;
- new paid service/API/infrastructure/credits/plan;
- destructive action on real data;
- material accounting/tax policy change not already approved;
- secrets/credentials;
- material unresolved requirement ambiguity;
- sensitive real-user access changes involving Administrator-level access, cross-company expansion, approve/post/reopen/user-administration privileges, or real-user credentials/secrets;
- exceptional Git recovery such as force-push/history rewrite/destructive repository recovery.

Developing permission features inside the approved roadmap is not automatically a Human Gate.

## User Communication States

- `NO ACTION REQUIRED` — project proceeds autonomously.
- `SYNC ASSISTANCE REQUIRED` — temporary Replit-only operational sync assistance; not approval/acceptance/Human Decision.
- `HUMAN DECISION REQUIRED` — Human Gate only.
- `USER VALIDATION REQUIRED` — practical validation after a Phase or meaningful testable increment, with exact steps and expected result.

The user is not a routine Git/branch/PR/CI/Codex integration operator.

## Replit Current State

**Replit Sync PoC: PASS WITH HUMAN ACTION**.

Proven:
- GitHub/main synchronized successfully to Replit;
- verified PoC SHA: `2644c9fde0062221240409d47795ae2ee0d022e3`;
- Preview startup: **PASS**.

Not proven:
- full autonomous GitHub → Replit sync;
- runtime SHA verification from the running application.

Replit remains runtime/practical validation only. Replit Agent may be used only in FREE MODE within the approved operational allowlist. It remains prohibited for Product coding/refactoring, accounting/tax logic, DB/schema design/migrations, branch reconstruction, PR rescue, GitHub push/write/PR, Power, Max, and paid credits/additional paid usage.

## Cloud Codex / Tooling Recovery

Permanent principle:

**GitHub = durable project state. Codex session = disposable executor.**

Normal Builder recovery:

`Cloud Codex → one bounded tooling retry → fresh Cloud Codex session from verified GitHub state → approved Local Codex/fallback when applicable → STOP or Human Gate only when required`

No infinite retry loops, automatic paid credits, rebuilding valid durable work, or claims that session-local work is durable.

## مبادئ حاكمة

- لا اعتماد على Workspace مؤقت أو ذاكرة المحادثة كمصدر دائم للحالة.
- لا Production دون Human Gate.
- لا خدمة/API/Credits/ترقية/تكلفة جديدة دون Human Gate.
- مهمة برمجية واحدة فقط في كل مرة.
- أقل تعديل ممكن يحقق Execution Contract مع اختبارات قابلة للتحقق.
- قابلية النقل خارج Replit شرط معماري دائم.
- عزل الشركات والصلاحيات والأمان لا تؤجل إلى نهاية المشروع.
- UI/API وحدها لا تثبت اكتمالًا محاسبيًا.
- القوائم والزكاة والضرائب الحساسة لا تستبدل الحكم المهني للمحاسب/المستشار المخول.

## Agent Readiness Sequence

بعد دمج حوكمة Autonomous Operating Model:
1. Build/test Orchestrator.
2. Build/test Builder Role + Cloud Codex primary integration.
3. Build/test Independent Reviewer.
4. Run Autonomous Agent PoC.
5. Resume real Product roadmap only after readiness is actually proven.

لا تدّعي الوثائق أن Autonomous Agents جاهزون قبل البناء والاختبار الفعلي.
