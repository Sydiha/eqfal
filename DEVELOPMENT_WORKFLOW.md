# DEVELOPMENT_WORKFLOW

This file provides supplementary development guidance. It is lower authority than `AGENTS.md` and `docs/WORKFLOW_GOVERNANCE.md` and must never override them.

## بداية كل مهمة

1. EQFAL Project يحدد المهمة التالية من `GitHub/main` + Roadmap + dependencies وفق الحوكمة.
2. يبدأ Product work بـRead-only Design Check.
3. إذا تحققت شروط Internal Design Approval ولا يوجد Human Gate، يصدر EQFAL Project Execution Contract دون routine user approval.
4. Orchestrator يثبت baseline/preflight readiness.
5. Builder يعمل من clean verified checkout على exact approved baseline وبفرع مستقل.

## أثناء التنفيذ

- أقل تعديل ممكن يحقق Execution Contract.
- لا توسع جانبي ولا تغيير Roadmap/Scope من Builder أو Orchestrator.
- لا مهمة برمجية ثانية قبل إغلاق الحالية تقنيًا إلا لسبب حقيقي تبرره الحوكمة.
- أي Migration يجب أن تكون ضمن Execution Contract المعتمد وأن تمر البوابات المناسبة قبل أي Production consideration.
- One-Shot Rule وZero-Loop Rule مستمران.

## توزيع المسؤوليات

### EQFAL Project
Product Owner + Lead PM + Roadmap Authority. يقرر WHAT / WHY / WHEN، يقرأ current `main` والRoadmap، يختار المهمة، ينفذ Design Check، يعتمد داخليًا عند الأهلية، يصدر Execution Contract، ويحدد Human Gate/User Validation.

### Orchestrator
يدير baseline/preflight، Builder routing، durable checkpoints، tooling recovery، Reviewer routing، CI، Merge Gate، merge المتوافق، post-merge baseline، وruntime validation coordination. ليس Product Authority.

### Builder
Governance role. Cloud Codex هو Primary Execution Engine. Builder ينفذ الكود/الاختبارات/commit/push/PR ضمن العقد فقط، ولا يملك Design/Review/Merge/Production/Cost Authority.

### Independent Reviewer
يراجع actual GitHub diff مقابل Execution Contract ويصدر `PASS` أو `FAIL` أو `NEEDS_CORRECTION`. لا self-review ولا self-merge.

### GitHub
`GitHub/main` هو sole source of truth للحالة المدمجة والدائمة. Branches/commits/PRs/diffs/CI/merge history هي durable delivery evidence.

### Replit
Runtime/practical validation target فقط، وفق حدود `AGENTS.md` و`docs/WORKFLOW_GOVERNANCE.md`.

## Replit Policy — FREE MODE ONLY

الحظر المطلق القديم على Replit Agent **superseded**. السياسة الحالية:

**Replit Sync PoC: PASS WITH HUMAN ACTION**.

المسموح فقط في FREE MODE:
- GitHub `main` → Replit sync؛
- Git state checks؛
- application startup؛
- Preview/basic smoke/runtime validation؛
- runtime SHA verification عندما تثبت القدرة تقنيًا.

الممنوع:
- Product coding أو source modification/refactoring/feature implementation؛
- accounting/tax logic؛
- DB/schema design أو migrations؛
- branch reconstruction/PR rescue/patch relay؛
- GitHub push/write/PR؛
- Power؛
- Max؛
- paid credits/additional paid usage.

الحالة المؤقتة `SYNC ASSISTANCE REQUIRED` مسموحة فقط عندما يحتاج GitHub → Replit sync تدخلًا تشغيليًا بسيطًا من المستخدم. ليست Approval ولا User Acceptance ولا Human Decision.

## Tooling Recovery

المبدأ:

**GitHub = durable project state. Codex session = disposable executor.**

المسار الطبيعي:

`Cloud Codex → one bounded tooling retry → fresh Cloud Codex session from verified GitHub state → approved Local Codex/fallback when applicable → STOP or Human Gate only when required`

لا infinite retry loops، لا automatic paid credits، لا Replit Git rescue، ولا اعتبار session-local state مصدرًا دائمًا.

## خطوط حمراء للتكلفة والProduction

Human Gate إلزامي عند:
- Production deployment/change؛
- new paid service/API/infrastructure/credits/plan؛
- destructive real-data action؛
- material accounting/tax policy change غير معتمد؛
- secrets/credentials؛
- material unresolved requirement ambiguity؛
- specified sensitive real-user permission changes؛
- force-push/history rewrite/destructive Git recovery.

تطوير permission features داخل approved roadmap ليس Human Gate تلقائيًا؛ تغيير الوصول الفعلي الحساس لمستخدمين حقيقيين هو الذي يطبق عليه gate وفق الحوكمة.

## بوابات الجودة قبل Merge

حسب طبيعة المهمة، يجب أن تتوفر evidence فعلية لـ:
- actual GitHub PR targeting `main`؛
- correct approved baseline/task lineage؛
- scope/Execution Contract compliance؛
- Independent Reviewer = `PASS`؛
- required CI = `PASS` على exact intended PR head SHA؛
- applicable tests/typecheck/build؛
- tenant isolation/permissions/audit/accounting/tax/schema review عند الصلة؛
- no unresolved PROJECT/TOOLING blocker affecting correctness/delivery؛
- no Human Gate.

Reviewer PASS وحده لا يكفي. CI PASS وحده لا يكفي.

## PR وMerge

- لا direct unreviewed merge إلى `main`.
- PR يجب أن يكون independently reviewable من actual GitHub diff.
- Orchestrator يمكنه automatic merge بدون routine user approval فقط إذا اكتملت كل شروط Merge Gate في `docs/WORKFLOW_GOVERNANCE.md`.
- إذا فشل شرط واحد: `NO MERGE`.
- Builder لا يراجع أو يدمج نفسه.
- Production يحتاج Human Gate مستقلًا حتى لو تم Merge.

## User Communication

الحالات المعتمدة:
- `NO ACTION REQUIRED`؛
- `SYNC ASSISTANCE REQUIRED`؛
- `HUMAN DECISION REQUIRED`؛
- `USER VALIDATION REQUIRED`.

المستخدم ليس Git/PR/CI/Codex integration operator روتينيًا.

## نهاية المهمة

بعد merge متوافق:
- Orchestrator يسجل new `main` SHA ويثبت diff/review/CI evidence؛
- ينسق runtime validation ضمن الحدود المسموحة؛
- يعيد الحالة إلى EQFAL Project؛
- EQFAL Project يقرر task completion / next task / User Validation / Human Gate.

تحديث ملفات current-state/history مثل `TODO.md`, `DECISIONS.md`, أو `RECAP_SESSION.md` يتم فقط عندما تقتضي repository policy/الحالة الفعلية ذلك؛ لا يعتبر `RECAP_SESSION.md` أعلى من authority hierarchy ولا يستخدم لتجاوز current `main`/Roadmap.

## قاعدة الإثبات

لا يذكر اختبار أو build أو review أو CI أو merge أو sync أو deployment على أنه نجح إلا إذا نفذ فعليًا وكانت النتيجة قابلة للتحقق.
