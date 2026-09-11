# PROJECT_BRIEF

## اسم المشروع
إقفال | EQFAL — منصة الإدارة والإقفال المالي

## الهدف
بناء نظام ويب مالي داخلي متعدد الشركات، ثنائي اللغة، Mobile First، يساعد الإدارة والمحاسب على جمع الواقع التشغيلي والمستندات والحركات وربطها ومراجعتها ثم الإقفال وتجهيز مخرجات القوائم والزكاة وVAT تدريجيًا.

## Authority

Current merged project state is determined by this hierarchy:

`GitHub/main → AGENTS.md → docs/WORKFLOW_GOVERNANCE.md → docs/TOOLING_RECOVERY_PLAYBOOK.md → docs/EXECUTION_ROADMAP.md → TODO.md → Historical records`

- `GitHub/main` هو المرجع الدائم والوحيد للكود والحالة المدمجة.
- Historical records لا تتغلب على الحالة الحالية أو القواعد الأعلى.
- عند تعارض جوهري غير محسوم من hierarchy: STOP + escalate.

## Current Project State

Last reconciled against GitHub/main SHA:
`6b1b75382d9cedb9d2b2fb229aa3e9a860cbbc69`

Reconciliation date:
`2026-09-11`

هذا SHA هو **audit/reconciliation baseline فقط**، وليس ضمانًا بأنه سيظل current HEAD مستقبلًا.

EQFAL تجاوز مرحلة تأسيس النواة. التنفيذ المدمج على `main` يشمل حاليًا foundations/workflows فعلية للمصادقة والعزل والصلاحيات وFiscal Years وDocuments وBanking وPartners وObligations وAccounting Ledger وSales وPurchases وFixed Assets وOpening Balances وPeriodic Adjustments وVAT وMonthly Close وAnnual Closing readiness.

### Reconciled roadmap status

- Phase 1 — Company Accounting & Tax Profile: **DONE**
- Phase 2 — Fixed Asset Depreciation Policy: **PARTIAL**
- Phase 3 — Opening Balance Review: **DONE**
- Phase 4 — Accruals / Prepayments / Periodic Adjustments: **DONE**
- Phase 5 — Financial Statement Mapping: **NOT STARTED**
- Phase 6 — VAT Reconciliation Hardening: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 7 — Zakat / Income Tax / Withholding Tax: **PARTIAL**
- Phase 8 — Integrated Monthly Close: **PARTIAL / STRONG FOUNDATION**; a dedicated completeness gap audit is still required against the latest roadmap.
- Phase 9 — Final Permission Model: **PARTIAL**
- Phase 10 — Company Manager Workspace: **PARTIAL**
- Phase 11 — Home Screen Alerts: **PARTIAL**
- Phase 12 — Manager Financial Snapshot: **NOT STARTED**
- Phase 13 — Conditional Modules: **DEFERRED**
- Phase 14 — Full Operational & Accounting Cycle Validation: **NOT STARTED**
- Phase 15 — System-wide UI/UX Redesign: **DEFERRED**

`Phase 6 — VAT` is complete only for the currently approved scope; this does not close or pre-approve any future tax scope.

After governance/Agent-readiness work, the **NEXT REAL PRODUCT GAP** is:

**Phase 5 — Financial Statement Mapping**

No Phase 5 implementation begins until its own Read-only Design Check is completed and approved.

## مبادئ حاكمة

- لا اعتماد على Workspace مؤقت أو ذاكرة المحادثة كمصدر دائم للحالة.
- لا Publish إلى Production دون موافقة صريحة.
- لا خدمة مدفوعة أو API مدفوع أو Credits إضافية أو ترقية خطة دون موافقة.
- مهمة برمجية واحدة فقط في كل مرة.
- أقل تعديل ممكن مع اختبارات قابلة للتحقق.
- قابلية النقل خارج Replit شرط معماري دائم.
- عزل الشركات والصلاحيات والأمان لا تؤجل إلى نهاية المشروع.
- لا تعتبر UI/API وحدها دليل اكتمال محاسبي.
- القوائم والزكاة والضرائب الحساسة لا تستبدل الحكم المهني للمحاسب/المستشار المخول.

## بروتوكول الأدوات والتكلفة

### Replit Agent — FREE MODE ONLY

Replit Agent مسموح فقط في **FREE MODE** وللنطاق التشغيلي المحدود التالي، **subject to successful Replit Sync Proof of Concept**. السماح بهذه السياسة لا يعني أن autonomous/end-to-end synchronization قدرة مثبتة أو production-ready حتى الآن.

المسموح فقط:
- GitHub `main` → Replit sync.
- Git state checks.
- application startup.
- basic smoke tests.
- runtime/latest-approved-main SHA verification.

الممنوع:
- coding.
- refactoring.
- feature implementation.
- accounting/tax logic changes.
- database/schema design أو migrations.
- PR rescue أو branch reconstruction أو patch relay.
- push/write/PR actions إلى GitHub.
- Power Mode.
- Max Mode.
- paid credits أو أي paid usage إضافي.

إذا لم يعد Free Mode مجانيًا فعليًا أو تطلبت المهمة الخروج من allowlist: **STOP**.

Replit ليس Source of Truth ولا Git delivery bridge. إثبات Replit Sync PoC يبقى Agent-readiness blocker مستقلًا حتى ينجح عمليًا.

### توزيع المسؤوليات

- **Chat:** النقاش، التخطيط، Design Check، اتخاذ القرارات، قيادة المشروع والمراجعات القصيرة.
- **Work:** الوثائق المفصلة، التقارير، المواصفات الطويلة، والمخرجات المنظمة.
- **Codex:** التنفيذ البرمجي، التعديلات، الإصلاحات، refactors، الاختبارات والتحقق البرمجي بعد Design Approval.
- **GitHub:** durable source of truth للحالة المدمجة، branches/PRs/diffs/CI/merge history.
- **Replit Free Mode:** operational runtime assistance فقط ضمن allowlist وبعد إثبات PoC.

## Cloud Codex resilience

المبدأ الدائم:

**GitHub = durable project state. Codex session = disposable executor.**

Tooling failures لا تتحول إلى إعادة بناء للميزة. يسمح بمحاولة tooling retry واحدة فقط، ثم fresh Codex session من GitHub state موثوق، ثم approved fallback / STOP. لا infinite retry loops، لا شراء credits تلقائيًا، ولا ادعاء حفظ session-local work غير الموجود في durable checkpoint.

التفاصيل canonical في:
`docs/TOOLING_RECOVERY_PLAYBOOK.md`

## خطوط التكلفة الحمراء

- لا خدمة مدفوعة جديدة.
- لا API مدفوع.
- لا Credits إضافية.
- لا ترقية خطة.
- لا تكلفة تشغيلية جديدة إلا بموافقة صريحة من المستخدم.

## بوابات العمل

- أي مهمة برمجية تبدأ Read-only Design Check.
- التنفيذ بعد الاعتماد فقط، بفرع مستقل وPR إلى `main`.
- القبول يعتمد على diff الحقيقي + الاختبارات/CI + مطابقة Design Check.
- Production خارج النطاق ما لم يعتمد المستخدم ذلك صراحة.
