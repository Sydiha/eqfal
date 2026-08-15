# RECAP_SESSION

## آخر تحديث
2026-08-15

## حالة المشروع
مشروع **إقفال | EQFAL** مستمر في بناء Core MVP. تم إغلاق ودمج Core Security/Readiness، Phase 2A Secure Document Upload Foundation، وPhase 2B Document Review Workflow. لا توجد مهمة برمجية مفتوحة حاليًا؛ الحزمة الحالية هي Documentation Recovery فقط.

## المرجع المعتمد
- Repository: `Sydiha/eqfal`
- المرجع الوحيد للكود المدمج: latest `main` على GitHub.
- آخر Merge تشغيلي: PR #20 — `feat: add document review workflow`.
- آخر Merge حوكمة قبلها: PR #19 — `docs: enforce strict Design Check compliance`.
- لا يعتمد هذا الملف على SHA ثابت كمرجع دائم؛ عند الاستئناف يجب قراءة latest `main` مباشرة.

## ما تم إنجازه حتى الآن
- Bootstrap Core Foundation — DONE.
- Data / Tenancy Foundation — DONE.
- Auth / Users Foundation — DONE.
- Memberships + Roles + Capabilities — DONE.
- Fiscal Years + Initial Audit Foundation — DONE.
- i18n + Company Switcher Foundation — DONE.
- Auth / Session + Secure Company Switching — DONE.
- Fiscal Year API / Application Integration — DONE.
- Fiscal Years UI / Authenticated Shell — DONE.
- GitHub Actions CI — DONE.
- Core MVP Security & Readiness — DONE.
- Phase 2A Secure Document Upload Foundation — DONE.
- Phase 2B Document Review Workflow — DONE.

## Phase 2A — Secure Document Upload Foundation
- `document.view` و`document.upload`.
- company-scoped metadata في PostgreSQL؛ لا BLOBs.
- replaceable Storage Adapter مع local implementation حاليًا.
- PDF/JPEG/PNG/WebP حتى 10 MB.
- extension + MIME + signature validation.
- SHA-256 server-side.
- Same-Origin upload.
- secure company-scoped file retrieval.
- Audit `document.upload`.
- Documents UI الأساسية.

## Phase 2B — Document Review Workflow
Transitions:
- `uploaded -> needs_review` عبر `document.upload`.
- `needs_review -> incomplete/rejected` عبر `document.review`.
- `needs_review -> approved` عبر `document.approve`.

API:
- `POST /api/documents/:id/submit-review`
- `POST /api/documents/:id/review`

ضوابط أساسية:
- Same-Origin + Auth + trusted Active Company.
- Backend decision-specific capability enforcement.
- company-scoped lookup + `FOR UPDATE` داخل transaction.
- safe 404 للـcross-company/not-found.
- 409 للحالة غير الصالحة.
- review note max 500.
- reason required لـincomplete/rejected؛ note اختيارية للاعتماد.
- submit-review لا يملأ reviewer metadata.
- final review actions تسجل `reviewed_by_user_id`, `reviewed_at`, `review_note`.
- Audit actions منفصلة: submit_review / mark_incomplete / reject / approve.
- الواجهة تفصل `canReview` و`canApprove` وتعرض review metadata عند وجودها.

## آخر تحقق تقني معتمد
PR #20 اجتاز GitHub Actions CI بالكامل على نفس الـhead الذي تم دمجه:
- Install dependencies: passed.
- TypeScript: passed.
- Tests: passed.
- Build: passed.

## قواعد سير العمل المعتمدة
- `GitHub/main` هو المرجع الدائم.
- لا Replit Agent لتعديل الكود.
- Chat + GitHub للإدارة، Design Check، المراجعة، PR/CI/merge ضمن الأدوات المتاحة.
- Codex للبرمجة فقط بعد اعتماد Design Check.
- Replit Runtime/Preview يدوي فقط عند الحاجة.
- لا Production دون موافقة صريحة.
- لا خدمات مدفوعة أو تكلفة تشغيلية جديدة دون موافقة.
- مهمة برمجية واحدة فقط في كل مرة.
- Approved Design Check = binding implementation contract.
- **One-Shot Rule:** أمر Codex واحد شامل ومغلق بعد اعتماد التصميم.
- **Zero-Loop Rule:** corrective pass واحد فقط؛ الحاجة إلى تصحيح ثانٍ توقف المهمة فورًا.
- لا يعتمد المستخدم كوسيط نقل يدوي متكرر للـterminal/logs/patches.
- القبول من diff الحقيقي + tests/CI + مطابقة Design Check، وليس من agent summary وحده.

## ملاحظات تشغيلية معلقة وليست Blockers حالية
- `package-lock.json` يحتوي registry URLs قديمة من Replit؛ CI يطبعها مؤقتًا إلى npm public registry داخل Runner فقط. تنظيفه مهمة تشغيلية مستقلة.
- أي dependency vulnerability تحتاج مراجعة مستقلة قبل تغيير dependencies؛ لا automatic/breaking audit fix.
- Production غير منشور.

## نقطة الاستئناف التالية
بعد Merge حزمة Documentation Recovery:
1. قراءة latest `main`.
2. الرجوع للوثيقة التشغيلية الشاملة لتحديد المرحلة التالية.
3. إجراء Read-only Design Check فقط.
4. عدم كتابة أي كود حتى اعتماد المستخدم للتصميم.

## خارج النطاق الحالي
- OCR / AI extraction.
- VAT decisions/reconciliation.
- accounting entries.
- banks/reconciliation.
- notifications/email.
- Production deployment.
- أي خدمة مدفوعة جديدة.
