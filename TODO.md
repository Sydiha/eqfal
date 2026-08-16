# إقفال | EQFAL
# Project Progress & Status Report

آخر تحديث: 2026-08-16

## 1. الحالة التنفيذية المختصرة

مشروع **إقفال | EQFAL** مستمر في بناء Core MVP.

المرجع الدائم والوحيد للكود المدمج:
- Repository: `Sydiha/eqfal`
- Branch: `main`
- آخر main مؤكد وقت هذا التحديث: `39f8b888248711a306830bb8babd8cd29b759cc1`.

الحالة الحالية:
- Core security / tenancy / auth / memberships / capabilities foundations: DONE.
- Fiscal Years foundation + API + UI: DONE.
- Phase 2 — Documents: CLOSED.
- UI Modernization العام: CLOSED حتى PR #42.
- Phase 3A — Bank Import Foundation: CLOSED.
- Phase 3B — Bank Transaction Matching / Reconciliation Foundation: CLOSED.
- Phase 3C — Payment Settlement Foundation: CLOSED.
- **Phase 3D — Custody / Advances Foundation: CLOSED.**
- **Phase 3 — البنوك والدفعات والعهد: IN PROGRESS** حتى نجاح Practical Phase 3 sample validation.

Production:
- غير منشور.
- لا يجوز النشر دون موافقة صريحة.

---

## 2. Phase 2 — Documents — CLOSED

يشمل Secure Upload، review workflow، Manager Intake، company isolation، Audit، والرحلة العملية المعتمدة:
Upload → Intake → Submit → `needs_review` → Approve → Open original — PASS.

---

## 3. UI Modernization — CLOSED

المسار العام مغلق حتى PR #42، ويشمل AppShell/Home، Documents، Fiscal Years، Login، responsive Desktop/Mobile، RTL/LTR، date display، والحالات والنماذج والحوارات المشتركة.

لا يبدأ polishing عام جديد دون حاجة عملية مرتبطة بوظيفة أو شاشة جديدة.

---

## 4. Phase 3 — البنوك والدفعات والعهد — IN PROGRESS

بوابة المرحلة:
- **استيراد ومطابقة وتسويات على عينات.**

المبادئ الحاكمة:
- Excel/CSV أولًا؛ لا تكامل بنكي مباشر في MVP.
- البنك يثبت حركة النقد ولا يحدد وحده التصنيف المحاسبي.
- منع الاستيراد المكرر عبر idempotency/fingerprints.
- الصلاحيات مستقلة ولا يجوز أن تمنح DB defaults صلاحيات زائدة.
- company isolation عبر `company_id` + relationship checks وقيود مركبة حيث يلزم.
- Audit للتغييرات الحساسة.
- منع silent overwrite بالتزامن المناسب.

### 4.1 Phase 3A — Bank Import Foundation — CLOSED

تم إنجاز CSV/XLSX import، bank accounts، mapping، preview/confirm، persistence، duplicate/idempotency protection، company-scoped constraints، capabilities، audit، XLSX security hardening، وBanking UI الأساسية.

### 4.2 Phase 3B — Bank Transaction Matching / Reconciliation Foundation — CLOSED

PR #50. Merge commit `e70d34d119669e45d2650fbe3d52bbf868070950`.

تم إنجاز manual bank transaction ↔ document matching، حالات `unmatched / matched / reconciled`، صلاحيات `bank.match` و`bank.reconcile`، company-scoped safe lookups، composite constraints، row locking/state validation، audit، وminimal reconciliation UI.

### 4.3 Phase 3C — Payment Settlement Foundation — CLOSED

PR #54. Merge commit `4895bbbc66387e5574d97bc2b051c45dc400078a`.

تم إنجاز:
- جدول `document_settlements`.
- صلاحية مستقلة `payment.settle`.
- settlement فقط مقابل document معتمد وحركة بنكية مطابقة له.
- عدة settlements للمستند عبر حركات بنكية مختلفة.
- منع استخدام حركة بنكية واحدة في أكثر من settlement.
- derived payment status: `unpaid / partially_paid / paid`.
- رفض overpayment.
- عدم خلط settlement status مع document review status أو accounting/tax classification.
- create/delete APIs مع mandatory reason عند الحذف.
- company isolation وsafe 404 وcomposite DB constraints.
- transaction + row locking وإعادة حساب الإجمالي داخل المعاملة.
- Audit create/delete.
- minimal Settlement UI.
- exact monetary arithmetic باستخدام integer cents/`BigInt` بدل floating point.

التحقق النهائي:
- CI على PR #54: PASS.
- post-merge CI على `main`: PASS — run #95.
- TypeScript / Tests / Build: PASS.
- لا يوجد ادعاء بتطبيق migration 014 على PostgreSQL فعلي؛ التحقق المسجل tests/migration integrity/CI فقط.

### 4.4 Phase 3D — Custody / Advances Foundation — CLOSED

التنفيذ المعتمد: PR #57.
Merge commit: `39f8b888248711a306830bb8babd8cd29b759cc1`.

تم إنجاز:
- جدول `custody_advances` لتمثيل العهدة/السلفة التشغيلية.
- جدول `custody_document_allocations` لربط المستندات المعتمدة بالعهدة.
- صلاحيات مستقلة: `custody.view`, `custody.manage`, `custody.close`.
- تمويل العهدة من حركة بنكية خارجة واحدة ضمن هذه الحزمة.
- مرتجعات العهدة عبر حركات بنكية داخلة، مع إمكانية تعدد المرتجعات.
- توسيع `bank_transaction_matches` إلى bank-explanation boundary مشترك بأنواع `document / custody_funding / custody_return` مع بقاء حركة بنكية واحدة = تفسير تشغيلي واحد.
- المستند الممول من العهدة يجب أن يكون `approved`.
- في هذه المرحلة، Custody Allocation للمستند يغطي كامل إجمالي المستند، ولا يُسمح بمصدر تمويل آخر موازٍ له.
- derived funded / allocated / returned / remaining balances باستخدام exact integer cents و`BigInt`.
- منع الرصيد السالب غير المتسق بدل إخفائه أو clamp إلى صفر.
- رفض Return يتجاوز المتبقي، ورفض إعادة استخدام حركة بنكية مستخدمة.
- Close فقط عند remaining = 0.
- Reopen بسبب إلزامي وAudit.
- منع التعديل على العهدة بعد الإغلاق حتى إعادة فتحها.
- reconciliation البنكي يدعم custody explanations دون أن يعني إغلاق العهدة.
- company isolation وsafe lookups وعلاقات مركبة مرتبطة بالشركة.
- transaction + row locking للمسارات الحساسة.
- Audit لإنشاء العهدة، allocation/remove، return link/unlink، close/reopen.
- minimal bilingual Custody UI ضمن Banking.
- behavioral tests للقواعد الحرجة إضافة إلى migration-integrity وUI capability gating.

التحقق النهائي:
- PR #56: أُغلق بدون دمج وفق Zero-Loop بعد أن أظهرت المراجعة النهائية نقصًا في التغطية السلوكية لبعض شروط القبول.
- PR #57: إعادة تنفيذ نظيفة من `main` ضمن نفس Design Check.
- CI على PR #57: run #101 — PASS.
- post-merge CI على `main`: run #102 — PASS.
- TypeScript: PASS.
- Tests: PASS.
- Build: PASS.
- لا Production.
- لا خدمات أو تكاليف تشغيلية جديدة.
- لا يوجد ادعاء بتطبيق migration 015 على PostgreSQL فعلي؛ التحقق المسجل tests/migration integrity/CI فقط.

حدود Phase 3D المؤجلة:
- الدفع الشخصي من مال المدير/الموظف نيابة عن الشركة.
- multiple funding sources للمستند.
- أكثر من Funding transfer للعهدة نفسها.
- one bank transaction → multiple operations.
- splitting one bank transaction across multiple documents/operations.
- advanced overpayment/prepayment allocation.
- GL/VAT/accounting classification.
- AI/external services.

---

## 5. المهمة التالية — Practical Phase 3 Sample Validation

**Phase 3 لا تُغلق بعد.**

الخطوة التالية هي إعداد واعتماد **Read-only/Test Execution Plan** للتحقق العملي من بوابة المرحلة، ثم تنفيذ التحقق فقط دون توسع برمجي إلا إذا كشف الاختبار blocker حقيقي يحتاج مهمة مستقلة.

العينة العملية يجب أن تثبت على الأقل:
1. CSV/XLSX import لعينة آمنة.
2. إعادة نفس الاستيراد وإثبات idempotency وعدم التكرار.
3. Match لحركة بنكية مع مستند ضمن active company.
4. Reconciliation للمسار المسموح.
5. Payment Settlement لمستند معتمد ومطابق.
6. Custody creation من حركة بنكية خارجة.
7. Custody allocation لمستند معتمد.
8. Custody return من حركة بنكية داخلة إذا بقي رصيد.
9. Close عند remaining = 0.
10. التحقق من company isolation والصلاحيات والأثر المسجل في Audit أثناء الرحلة.

شروط التحقق:
- لا Production.
- لا بيانات حقيقية حساسة في Staging/Preview دون تنقيح.
- لا تكلفة تشغيلية جديدة.
- لا تعديل برمجي ضمن مهمة التحقق نفسها إلا بعد فتح Design Check/مهمة مستقلة لأي blocker يظهر.

بعد نجاح هذا الاختبار وتوثيق الأدلة يمكن تقييم إغلاق Phase 3 العامة والانتقال إلى المرحلة التالية في الوثيقة التشغيلية.

---

## 6. Operating Rules — ACTIVE

- `GitHub/main` هو المرجع الدائم.
- Design Check المعتمد عقد تنفيذ ملزم.
- One-Shot Rule بعد اعتماد التصميم.
- Zero-Loop Rule: corrective pass واحد كحد أقصى للمهمة البرمجية.
- القبول من diff الحقيقي + tests/CI + مطابقة Design Check.
- مهمة برمجية واحدة فقط في كل مرة.
- Replit Agent محظور؛ Replit Runtime / Preview يدوي فقط عند الحاجة.
- لا Production دون موافقة.
- لا تكلفة تشغيلية جديدة دون موافقة.

---

## 7. Operational Backlog مستقل

- Portable Dependency Lockfile: إزالة registry URLs القديمة الخاصة بـReplit من `package-lock.json` مع الحفاظ على dependency graph قدر الإمكان ونجاح CI.
- Dependency security review فقط عند الحاجة الفعلية؛ لا `npm audit fix` عشوائي أو breaking upgrade دون مراجعة.
- Staging validation قبل أي Production مستقبلًا.

### Deferred حتى مراحلها المعتمدة
- Practical Phase 3 sample validation قبل إغلاق Phase 3.
- المطابقة التلقائية/scoring/AI.
- many-to-many transaction/document matching.
- one bank transaction → multiple operations.
- advanced partial / over / prepayment allocation beyond current foundations.
- الدفع الشخصي نيابة عن الشركة.
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
