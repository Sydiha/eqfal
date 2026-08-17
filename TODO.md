# إقفال | EQFAL
# Project Progress & Status Report

آخر تحديث: 2026-08-17

## 1. الحالة التنفيذية المختصرة

مشروع **إقفال | EQFAL** مستمر في بناء Core MVP.

المرجع الدائم والوحيد للكود المدمج:
- Repository: `Sydiha/eqfal`
- Branch: `main`
- مرجع الإغلاق العملي لـPhase 3: `18348d67482048e6bf0edb5375936f1b23dfdea1`.

الحالة الحالية:
- Core security / tenancy / auth / memberships / capabilities foundations: DONE.
- Fiscal Years foundation + API + UI: DONE.
- Phase 2 — Documents: CLOSED.
- UI Modernization العام: CLOSED حتى PR #42.
- Phase 3A — Bank Import Foundation: CLOSED.
- Phase 3B — Bank Transaction Matching / Reconciliation Foundation: CLOSED.
- Phase 3C — Payment Settlement Foundation: CLOSED.
- Phase 3D — Custody / Advances Foundation: CLOSED.
- Phase 3E — Real Bank Statement Import Readiness: CLOSED.
- **Phase 3 — البنوك والدفعات والعهد: CLOSED.**

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

تم تسجيل مهمة UI/UX مستقلة بعد إغلاق Phase 3 لمراجعة الصفحات المتأثرة، خصوصًا جداول البنوك: النصوص المقطوعة، اتساق الأزرار والحالات، عرض الأعمدة، RTL/LTR، المبالغ والتواريخ، والـresponsive behavior. لا تعالج هذه الملاحظات بترقيع صفحة واحدة.

---

## 4. Phase 3 — البنوك والدفعات والعهد — CLOSED

بوابة المرحلة:
- **استيراد ومطابقة وتسويات على عينات — PASS عمليًا.**

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
- رفض Return يتجاوز المتبقي، ورفض إعادة استخدام حركة بنكية مستخدمة.
- Close فقط عند remaining = 0.
- Reopen بسبب إلزامي وAudit.
- منع التعديل على العهدة بعد الإغلاق حتى إعادة فتحها.
- reconciliation البنكي يدعم custody explanations دون أن يعني إغلاق العهدة.
- company isolation وsafe lookups وعلاقات مركبة مرتبطة بالشركة.
- transaction + row locking للمسارات الحساسة.
- Audit لإنشاء العهدة، allocation/remove، return link/unlink، close/reopen.
- minimal bilingual Custody UI ضمن Banking.

### 4.5 Phase 3E — Real Bank Statement Import Readiness — CLOSED

تم التحقق من كشف XLSX بنكي حقيقي End-to-End:
- Preview: `289/289` صحيحة.
- Duplicate: `0`.
- Invalid: `0`.
- Confirm: تم إنشاء `289` حركة فعلية في `bank_transactions`.
- تم التحقق عمليًا من المدين/الدائن والأرصدة.

### 4.6 Practical Phase 3 Sample Validation — PASS

تم تنفيذ بوابة الإغلاق عمليًا على بيئة الاختبار بدون Production وبدون تعديل كود المنتج.

الأدلة المسجلة:
- migrations `013`, `014`, `015` مطبقة فعليًا في PostgreSQL الخاص ببيئة الاختبار.
- Bank transaction ↔ Document Match: PASS.
- Reconciliation: PASS.
- Payment Settlement: PASS؛ settlement فعلي بقيمة `150.00` على مستند معتمد ومطابق.
- Custody creation: PASS من حركة خارجة `-500.00`.
- Custody allocation: PASS بقيمة `350.00` لمستند معتمد.
- Custody return: PASS بحركة داخلة `+150.00`.
- Custody remaining: `0.00`.
- Custody close: PASS والحالة النهائية `closed`.
- Audit trail: PASS، بما يشمل `bank_transaction.match`, `bank_transaction.reconcile`, `document_settlement.create`, `custody.create`, `custody.document.allocate`, `custody.return.link`, `custody.close`.
- Company isolation: PASS عمليًا عبر Company B مؤقتة؛ لم تظهر بيانات Company A في العرض، ثم حُذف الـfixture بعد الاختبار.
- Capabilities/permissions: PASS؛ تشغيل 5 ملفات اختبار مرتبطة أعطى `31/31` اختبار ناجح، وتشمل حدود reconciliation/settlement/custody والعزل/authorization.
- Fixture الاختبار المؤقت تم تنظيفه بالكامل؛ بقيت `Test Company` فقط.
- لم يظهر Blocker برمجي جديد أثناء Practical Gate.

**الحكم النهائي:** Phase 3 العامة مغلقة رسميًا بعد نجاح بوابة العينة العملية.

حدود Phase 3 المؤجلة:
- الدفع الشخصي من مال المدير/الموظف نيابة عن الشركة.
- multiple funding sources للمستند.
- أكثر من Funding transfer للعهدة نفسها.
- one bank transaction → multiple operations.
- splitting one bank transaction across multiple documents/operations.
- advanced overpayment/prepayment allocation.
- المطابقة التلقائية/scoring/AI.
- GL/VAT/accounting classification.
- AI/external services.

---

## 5. المهمة التالية المقترحة

**UI/UX Review — Banking & Affected Operational Tables**

مهمة مستقلة Read-only Design Check أولًا لمعالجة النمط على الصفحات المتأثرة، خصوصًا:
- النصوص المقطوعة.
- عدم اتساق الأزرار والحالات.
- توزيع وعرض الأعمدة.
- RTL/LTR.
- تنسيق المبالغ والتواريخ.
- responsive behavior.

لا يبدأ أي تعديل قبل Design Check واعتماد النطاق، ولا تعالج المشكلة بترقيع صفحة واحدة.

بعد هذه المهمة يمكن متابعة Roadmap الوظيفي المعتمد، وأقرب مرحلة أعمال رئيسية في الوثيقة التشغيلية هي Phase 4 — الشركاء والذمم.

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

- UI/UX review للصفحات المتأثرة بعد إغلاق Practical Phase 3 Gate.
- Portable Dependency Lockfile: إزالة registry URLs القديمة الخاصة بـReplit من `package-lock.json` مع الحفاظ على dependency graph قدر الإمكان ونجاح CI.
- Dependency security review فقط عند الحاجة الفعلية؛ لا `npm audit fix` عشوائي أو breaking upgrade دون مراجعة.
- Staging validation قبل أي Production مستقبلًا.

### Deferred حتى مراحلها المعتمدة
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
