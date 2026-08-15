# إقفال | EQFAL
# Project Progress & Status Report

آخر تحديث: 2026-08-15

## 1. الحالة التنفيذية المختصرة

مشروع **إقفال | EQFAL** مستمر في بناء Core MVP، وقد تم إغلاق ودمج الأساسات الأمنية والتشغيلية الأساسية، ثم Phase 2A لرفع المستندات الآمن وPhase 2B لتدفق مراجعة المستندات.

المرجع الدائم والوحيد للكود المدمج:
- Repository: `Sydiha/eqfal`
- Branch: `main`
- المرجع الحالي دائمًا: latest GitHub `main`، ولا يعتمد هذا الملف على SHA ثابت يتقادم بعد كل Merge.

آخر الأعمال المدمجة:
- PR #19 — Strict Design Check compliance.
- PR #20 — Phase 2B Document Review Workflow.

Production:
- غير منشور.
- لا يجوز النشر دون موافقة صريحة.

---

## 2. Completed Foundations — DONE

- Bootstrap Core Foundation.
- Data / Tenancy Foundation.
- Auth / Users Foundation.
- Memberships + Roles + Capabilities.
- Fiscal Years + Initial Audit Foundation.
- Arabic/English + RTL/LTR.
- Company Switcher Foundation.
- Auth / Session + Secure Company Switching.
- Fiscal Year API / Application Integration.
- Fiscal Years UI / Authenticated Shell.
- GitHub Actions CI.
- Core MVP Security & Readiness hardening.
- Permanent Tool / Cost / Design Check guardrails.

---

## 3. Phase 2 — Documents

### 3.1 Phase 2A — Secure Document Upload Foundation — DONE

يشمل:
- company-scoped `documents` table.
- statuses: `uploaded | needs_review | approved | incomplete | rejected`.
- capabilities: `document.view`, `document.upload`.
- PDF/JPEG/PNG/WebP فقط، بحد 10 MB.
- extension/MIME/signature validation.
- SHA-256 server-side.
- replaceable Storage Adapter مع local implementation حاليًا.
- لا BLOBs داخل PostgreSQL.
- company-scoped list/read/file retrieval.
- Same-Origin للرفع.
- Audit `document.upload`.
- Documents UI الأساسية.

### 3.2 Phase 2B — Document Review Workflow — DONE

PR #20 merged.

Transitions:
- `uploaded -> needs_review` عبر `document.upload`.
- `needs_review -> incomplete` عبر `document.review`.
- `needs_review -> rejected` عبر `document.review`.
- `needs_review -> approved` عبر `document.approve`.

API:
- `POST /api/documents/:id/submit-review`
- `POST /api/documents/:id/review`

Security / consistency:
- Same-Origin على mutation endpoints.
- Authenticated Session + trusted Active Company.
- decision-specific capability enforcement في Backend.
- company-scoped lookup.
- `SELECT ... FOR UPDATE` داخل transaction.
- safe 404 للـcross-company/not-found.
- 409 للحالة غير الصالحة/stale transition.
- `review_note` بحد 500 حرف.
- سبب إلزامي لـ`incomplete` و`rejected`.
- `approved` يسمح بملاحظة اختيارية.
- `submit-review` لا يملأ reviewer metadata.
- `reviewed_by_user_id`, `reviewed_at`, `review_note` تُسجل فقط عند قرار المراجعة النهائي.

Audit actions:
- `document.submit_review`
- `document.mark_incomplete`
- `document.reject`
- `document.approve`

UI:
- Submit for review لمستخدمي `document.upload` على المستندات المرفوعة.
- Incomplete/Reject لمستخدمي `document.review` على `needs_review`.
- Approve لمستخدمي `document.approve` على `needs_review`.
- عرض review note وreviewed at عند وجودهما.

Verification:
- Phase 2B اجتازت GitHub Actions CI على PR #20: Install + TypeScript + Tests + Build.

---

## 4. Current Status

لا توجد مهمة برمجية مفتوحة حاليًا.

الحزمة الحالية:
- **Documentation Recovery** فقط.

بعد إغلاق التوثيق، لا تبدأ أي Feature جديدة قبل Read-only Design Check مستقل واعتماده.

---

## 5. Operating Rules — ACTIVE

- `GitHub/main` هو المرجع الدائم.
- Design Check المعتمد عقد تنفيذ ملزم.
- One-Shot Rule: بعد اعتماد التصميم، Codex يستلم أمر تنفيذ واحدًا شاملًا ومغلقًا.
- Zero-Loop Rule: يسمح بحد أقصى corrective pass واحد؛ الحاجة إلى تصحيح ثانٍ توقف المهمة فورًا.
- لا يعتمد المستخدم كوسيط نقل يدوي متكرر للـlogs/terminal/patches.
- القبول من diff الحقيقي + tests/CI + مطابقة Design Check، وليس من ملخص agent.
- مهمة برمجية واحدة فقط في كل مرة.
- لا Replit Agent للبرمجة.
- لا Production دون موافقة.
- لا تكلفة تشغيلية جديدة دون موافقة.

---

## 6. Remaining MVP / Operational Backlog

### P1 — بعد اعتماد Design Check جديد
- تحديد المرحلة التشغيلية التالية من الوثيقة الشاملة فقط بعد إغلاق Documentation Recovery.
- لا OCR / VAT / AI / Banks / Accounting Entries ضمن Phase 2B المغلقة.

### P2 — Operational cleanup مستقل
- Portable Dependency Lockfile: إزالة registry URLs القديمة الخاصة بـReplit من `package-lock.json` مع الحفاظ على dependency graph قدر الإمكان ونجاح CI.
- Dependency security review فقط عند الحاجة الفعلية؛ لا `npm audit fix` عشوائي أو breaking upgrade دون مراجعة.
- Staging validation قبل أي Production مستقبلًا.

### Deferred حتى مراحلها المعتمدة
- OCR/AI extraction.
- VAT reconciliation.
- Purchase/Sales invoices accounting workflow.
- Expenses / unknown transfers / personal withdrawals / advances.
- Bank transactions / reconciliation.
- Accounting periods / Month / Quarter close / reopen workflow.
- Zakat / year-end close / Financial Statements / Qawaem output.
- Notifications / email alerts.
- E-invoicing / external ERP integrations.
- Native mobile application.
- Paid AI/APIs.

---

## 7. Gate للمهمة التالية

قبل أي تنفيذ برمجي جديد يجب:
1. قراءة latest `main` فقط.
2. Read-only Design Check.
3. Scope / out-of-scope / API / capabilities / schema / transitions / validations / error semantics / tests / DoD مكتوبة بوضوح.
4. موافقة المستخدم الصريحة.
5. One-Shot implementation prompt واحد فقط إلى Codex.
6. مراجعة diff الفعلي.
7. Single Fix واحد كحد أقصى إن ظهر blocker.
8. PR + GitHub CI قبل Merge.
