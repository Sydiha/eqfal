# إقفال | EQFAL
# Project Progress & Status Report

آخر تحديث: 2026-08-16

## 1. الحالة التنفيذية المختصرة

مشروع **إقفال | EQFAL** مستمر في بناء Core MVP.

المرجع الدائم والوحيد للكود المدمج:
- Repository: `Sydiha/eqfal`
- Branch: `main`
- آخر main مؤكد وقت هذا التحديث: `4895bbbc66387e5574d97bc2b051c45dc400078a`.

الحالة الحالية:
- Core security / tenancy / auth / memberships / capabilities foundations: DONE.
- Fiscal Years foundation + API + UI: DONE.
- Phase 2A Secure Document Upload: DONE.
- Phase 2B Document Review Workflow: DONE.
- Phase 2C Manager Document Intake: DONE.
- Practical Manager Document Journey Validation على `main`: PASS.
- **Phase 2 — Documents: CLOSED.**
- UI Modernization العام: CLOSED حتى PR #42.
- **Phase 3A — Bank Import Foundation: CLOSED.**
- **Phase 3B — Bank Transaction Matching / Reconciliation Foundation: CLOSED.**
- **Phase 3C — Payment Settlement Foundation: CLOSED.**

Production:
- غير منشور.
- لا يجوز النشر دون موافقة صريحة.

---

## 2. Phase 2 — Documents — CLOSED

### 2.1 ما تم إنجازه
- رفع آمن ومستندات company-scoped.
- PDF/JPEG/PNG/WebP حتى 10 MB مع MIME/extension/signature validation وSHA-256.
- Storage Adapter قابل للاستبدال، بدون BLOBs كبيرة داخل PostgreSQL.
- دورة الحالات: `uploaded -> needs_review -> approved | incomplete | rejected`.
- صلاحيات مستقلة للعرض/الرفع/المراجعة/الاعتماد مع Backend enforcement.
- Manager Document Intake: نوع المستند، الجهة المقابلة، التاريخ، المرجع، الإجمالي، الملاحظة.
- Audit للتغييرات الحساسة.
- Documents UI responsive مع RTL/LTR وdialogs وحالات مشتركة.

### 2.2 التحقق العملي النهائي
تم تنفيذ الرحلة العملية على `main` ونجحت بالكامل:
1. Upload document — PASS.
2. Save intake metadata — PASS.
3. Submit for review — PASS.
4. Transition to `needs_review` — PASS.
5. Approve — PASS.
6. Transition to `approved` — PASS.
7. Open original file — PASS.

بذلك تحققت بوابة Phase 2 المعتمدة: **رحلة رفع/مراجعة عملية ناجحة**.

---

## 3. UI Modernization — CLOSED

تم إغلاق مسار التحديث البصري العام حتى PR #42، ويشمل AppShell/Home، Documents، Fiscal Years، Login، responsive Desktop/Mobile، RTL/LTR، date display، والحالات والنماذج والحوارات المشتركة.

لا يبدأ polishing عام جديد دون حاجة عملية مرتبطة بوظيفة أو شاشة جديدة.

---

## 4. Phase 3 — البنوك والدفعات والعهد — IN PROGRESS

بوابة المرحلة في الوثيقة التشغيلية:
- **استيراد ومطابقة وتسويات على عينات.**

المبادئ الحاكمة:
- Excel/CSV أولًا؛ لا تكامل بنكي مباشر في MVP.
- البنك يثبت ما دخل وخرج فعليًا لكنه لا يحدد وحده التصنيف المحاسبي.
- كل حركة مهمة يجب أن ترتبط تدريجيًا بالسبب/الجهة/المستند/العملية والمراجعة.
- منع الاستيراد المكرر عبر idempotency/fingerprints.
- التنفيذ بحزم صغيرة مستقلة وقابلة للاختبار.

### 4.1 Phase 3A — Bank Import Foundation — CLOSED

تم إنجاز:
- CSV/XLSX import.
- Bank accounts foundation.
- Column mapping.
- Preview/confirm flow.
- Bank transactions persistence.
- Strong/weak duplicate fingerprints وidempotency controls.
- Company-scoped data access والعلاقات المركبة المطلوبة.
- Bank capabilities الأساسية.
- Audit للعمليات الحساسة.
- XLSX security hardening.
- Banking UI الأساسية.
- TypeScript / Tests / Build / CI: PASS.

### 4.2 Phase 3B — Bank Transaction Matching / Reconciliation Foundation — CLOSED

PR المعتمد: #50.
Merge commit: `e70d34d119669e45d2650fbe3d52bbf868070950`.

تم إنجاز:
- manual bank transaction ↔ document matching.
- حالات التسوية البنكية: `unmatched / matched / reconciled`.
- صلاحيات مستقلة: `bank.match` و`bank.reconcile`.
- Eligible document matching ضمن `needs_review` أو `approved`.
- منع reconciliation النهائي إلا مع document معتمد.
- company-scoped lookups وsafe 404.
- composite DB tenancy constraints مع unique keys صالحة لـPostgreSQL.
- transactional row locking/state validation.
- Audit لأحداث match / unmatch / reconcile / reopen.
- minimal Banking reconciliation UI.
- migration-integrity test لمنع تكرار خطأ composite FK.

التحقق النهائي:
- TypeScript: PASS.
- Tests: PASS.
- Build: PASS.
- GitHub CI على PR: PASS.
- GitHub CI على `main` بعد الدمج: PASS.

ملاحظة:
PR #49 أُغلق بدون دمج بعد اكتشاف blocker في migration integrity، ثم أُعيد التنفيذ من `main` في PR #50 مع معالجة القيد من البداية.

### 4.3 Phase 3C — Payment Settlement Foundation — CLOSED

PR المعتمد: #54.
Merge commit: `4895bbbc66387e5574d97bc2b051c45dc400078a`.

تم إنجاز:
- capability مستقلة: `payment.settle`.
- جدول `document_settlements` بعلاقات company-scoped مركبة.
- one bank transaction per settlement في الحزمة الحالية.
- السماح بعدة حركات بنكية لتسوية مستند واحد تدريجيًا.
- اشتراط document معتمد ووجود match مسبق للحركة البنكية مع نفس المستند.
- منع over-settlement.
- حساب `unpaid / partially_paid / paid` مشتقًا من مبالغ التسويات دون تلويث حالة المستند التشغيلية.
- row locking على document والحركة البنكية لمنع التسوية المتزامنة غير الآمنة.
- Audit لإنشاء وحذف التسويات، مع سبب حذف إلزامي.
- منع فك match عن حركة بنكية لديها settlement قائمة.
- minimal bilingual settlement UI ضمن Banking flow.
- حسابات مالية decimal-safe باستخدام integer cents و`BigInt` بدل JavaScript floating-point arithmetic.
- regression test لدقة الهللات عند القيم الكبيرة.
- authorization / tenancy / state / migration-integrity / UI gating coverage المرتبطة بالحزمة.

التحقق النهائي:
- TypeScript: PASS.
- Tests: PASS.
- Build: PASS.
- GitHub CI على PR: PASS.
- GitHub CI #95 على `main` بعد الدمج: PASS.

ملاحظات تنفيذية:
- PR #52 أُغلق بدون دمج وفق Zero-Loop Rule بعد تعثر اختبار UI جديد عقب محاولة التصحيح الوحيدة.
- PR #54 أعاد التنفيذ من `main` في مسار نظيف.
- أثناء review النهائي اكتُشف خطر دقة مالية في `Number/toFixed()`؛ استُخدمت محاولة التصحيح الوحيدة لاستبدالها بحسابات integer cents وإضافة regression test، ثم نجح CI.
- PR #53 كان PR مكررًا أُنشئ بالخطأ وأُغلق فورًا بدون دمج.

Phase 3 ما زالت **IN PROGRESS** لأن العهد/السلف والسيناريوهات المتقدمة ليست مغلقة بعد، كما لم يُسجل بعد اختبار عملي شامل لبوابة Phase 3 على عينات حقيقية من الاستيراد → المطابقة → التسوية.

---

## 5. المهمة التالية المقترحة — Read-only Design Check

**Phase 3D — Custody / Advances Foundation**.

قبل أي كود:
- مراجعة أحدث `main` فقط والوثيقة التشغيلية المعتمدة.
- تحديد أقل نموذج للعهدة/السلفة يمكن اختباره دون توسع مبكر.
- حسم علاقته بالحركة البنكية والمستند والمستفيد.
- تحديد حالات الصرف والتسوية والإرجاع والإقفال.
- حسم ما إذا كان الدفع الشخصي نيابة عن الشركة يدخل في نفس النموذج أو يؤجل.
- حسم الصلاحيات وBackend enforcement.
- حسم company isolation وsafe 404.
- حسم Audit والتزامن/idempotency.
- تحديد الاختبارات المطلوبة.
- إبقاء many-to-many، overpayment، prepayment، والتصنيف المحاسبي النهائي خارج النطاق ما لم يثبت أنها لازمة للحزمة الأولى.
- لا تنفيذ قبل اعتماد Design Check.

بعد اكتمال حزمة Phase 3D، يجب تنفيذ **Practical Phase 3 sample validation** للتحقق من بوابة المرحلة: استيراد → مطابقة → تسويات على عينات، قبل إعلان Phase 3 مغلقة.

---

## 6. Operating Rules — ACTIVE

- `GitHub/main` هو المرجع الدائم.
- Design Check المعتمد عقد تنفيذ ملزم.
- One-Shot Rule بعد اعتماد التصميم.
- Zero-Loop Rule: corrective pass واحد كحد أقصى للمهمة البرمجية.
- القبول من diff الحقيقي + tests/CI + مطابقة Design Check.
- مهمة برمجية واحدة فقط في كل مرة.
- Replit Agent محظور؛ Replit Runtime / Preview يدوي فقط.
- لا Production دون موافقة.
- لا تكلفة تشغيلية جديدة دون موافقة.

---

## 7. Operational Backlog مستقل

- Portable Dependency Lockfile: إزالة registry URLs القديمة الخاصة بـReplit من `package-lock.json` مع الحفاظ على dependency graph قدر الإمكان ونجاح CI.
- Dependency security review فقط عند الحاجة الفعلية؛ لا `npm audit fix` عشوائي أو breaking upgrade دون مراجعة.
- Staging validation قبل أي Production مستقبلًا.

### Deferred حتى مراحلها المعتمدة
- المطابقة التلقائية/scoring/AI للمستندات والحركات.
- many-to-many transaction/document matching.
- overpayment / prepayment flows.
- الدفع الشخصي نيابة عن الشركة إذا لم يدخل في Phase 3D المعتمد.
- العهد/السلف المتقدمة خارج الحد الأدنى للحزمة التالية.
- OCR/AI extraction المدفوع أو أي AI محاسبي نهائي.
- VAT reconciliation.
- الشركاء والذمم (Phase 4).
- الإقفال الشهري (Phase 5).
- VAT (Phase 6).
- الزكاة والقوائم والإقفال السنوي (Phase 7).
- Production readiness (Phase 9).
- E-invoicing / external ERP integrations.
- Native mobile application.
- Paid AI/APIs.
