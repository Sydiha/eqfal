# إقفال | EQFAL
# Project Progress & Status Report

آخر تحديث: 2026-08-16

## 1. الحالة التنفيذية المختصرة

مشروع **إقفال | EQFAL** مستمر في بناء Core MVP.

المرجع الدائم والوحيد للكود المدمج:
- Repository: `Sydiha/eqfal`
- Branch: `main`
- آخر main مؤكد وقت هذا التحديث: `4e2ace50f8720f2cf758570d8d28405a185b67d3`.

الحالة الحالية:
- Core security / tenancy / auth / memberships / capabilities foundations: DONE.
- Fiscal Years foundation + API + UI: DONE.
- Phase 2A Secure Document Upload: DONE.
- Phase 2B Document Review Workflow: DONE.
- Phase 2C Manager Document Intake: DONE عبر PR #23.
- Practical Manager Document Journey Validation على `main`: PASS.
- **Phase 2 — Documents: CLOSED.**
- UI Modernization العام: CLOSED حتى PR #42.

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
تم تنفيذ الرحلة العملية على `main` الحالي ونجحت بالكامل:
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

## 4. المرحلة التالية المعتمدة من الوثيقة التشغيلية

**Phase 3 — البنوك والدفعات والعهد**.

بوابة الانتقال المحددة في الوثيقة التشغيلية:
- **استيراد ومطابقة وتسويات على عينات.**

المبادئ الحاكمة للمرحلة:
- Excel/CSV أولًا؛ لا تكامل بنكي مباشر في MVP.
- البنك يثبت ما دخل وخرج فعليًا لكنه لا يحدد وحده التصنيف المحاسبي.
- كل حركة مهمة يجب أن ترتبط تدريجيًا بالسبب/الجهة/المستند/العملية والمراجعة.
- منع الاستيراد المكرر عبر idempotency/fingerprints عند بناء الاستيراد.
- المرحلة تشمل البنوك والدفعات والعهد، لكن التنفيذ يبدأ بأصغر حزمة واحدة بعد Design Check، ولا تُبنى المرحلة كاملة دفعة واحدة.

---

## 5. المهمة التالية — Read-only Design Check

قبل أي كود في Phase 3:
- مراجعة `main` الحالية فقط.
- تحديد أقل حزمة أولى قابلة للاختبار من Phase 3.
- تحديد data model/API/capabilities/audit/tenancy boundaries المطلوبة.
- تحديد تنسيق Excel/CSV الأولي وسياسة duplicate detection.
- تحديد ما هو داخل النطاق وخارجه بوضوح.
- لا تنفيذ قبل اعتماد Design Check.

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
