# إقفال | EQFAL
# Project Progress & Status Report

آخر تحديث: 2026-08-16

## 1. الحالة التنفيذية المختصرة

مشروع **إقفال | EQFAL** مستمر في بناء Core MVP.

المرجع الدائم والوحيد للكود المدمج:
- Repository: `Sydiha/eqfal`
- Branch: `main`
- آخر main مؤكد وقت هذا التحديث: `98f1e82806c2210f391779504bdfaf3e76235d89`.

الحالة الحالية:
- Core security / tenancy / auth / memberships / capabilities foundations: DONE.
- Fiscal Years foundation + API + UI: DONE.
- Phase 2A Secure Document Upload: DONE.
- Phase 2B Document Review Workflow: DONE.
- Phase 2C Manager Document Intake: DONE ومُدمجة عبر PR #23.
- UI Shell / Documents redesign: DONE.
- Mantine UI foundation + responsive shell modernization: DONE.
- Documents UX modernization: DONE.
- Fiscal Years UX modernization: DONE.
- Locale-aware Gregorian date display: DONE.
- Login UX modernization: DONE عبر PR #41.
- Shared UI consistency / states / dialogs / forms polish: DONE عبر PR #42.

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

### 3.2 Phase 2B — Document Review Workflow — DONE
PR #20 merged.

Transitions:
- `uploaded -> needs_review` عبر `document.upload`.
- `needs_review -> incomplete/rejected` عبر `document.review`.
- `needs_review -> approved` عبر `document.approve`.

API:
- `POST /api/documents/:id/submit-review`
- `POST /api/documents/:id/review`

Security / consistency:
- Same-Origin على mutation endpoints.
- Authenticated Session + trusted Active Company.
- decision-specific capability enforcement في Backend.
- company-scoped lookup + transaction locking.
- safe 404 للـcross-company/not-found.
- 409 للحالة غير الصالحة/stale transition.
- `review_note` بحد 500 حرف.
- سبب إلزامي لـ`incomplete` و`rejected`.
- `approved` يسمح بملاحظة اختيارية.
- Audit actions for submit/review/approve transitions.

### 3.3 Phase 2C — Manager Document Intake — DONE
PR #23 merged.

تمت إضافة intake metadata للمستند مع الحفاظ على عزل الشركات والصلاحيات والتدفق الحالي، وتشمل الحقول الحالية:
- document type.
- counterparty name.
- document date.
- reference number.
- total amount.
- intake note.

الـUI الحالية تعرض وتسمح بتعديل بيانات intake ضمن الصلاحيات والحالة المسموحة، مع بقاء Backend هو المرجع النهائي للـauthorization والـworkflow.

### 3.4 UI / UX for Documents — DONE
- list/detail workspace.
- upload dialog.
- intake editor.
- review/approval dialogs.
- responsive desktop/mobile behavior.
- RTL/LTR support.
- shared form/state/dialog styling.

---

## 4. UI Modernization — CLOSED

تم إغلاق مسار التحديث البصري العام حتى PR #42.

يشمل:
- AppShell + Home modernization.
- responsive desktop/mobile shell.
- RTL/LTR fixes.
- Documents UX modernization.
- Fiscal Years UX modernization.
- Gregorian locale-aware display formatting.
- Login UX modernization.
- Shared loading/empty/error/no-access states.
- Shared form / button / dialog consistency.

لا يبدأ مسار polishing عام جديد دون حاجة عملية واضحة مرتبطة بوظيفة أو شاشة جديدة.

---

## 5. Current Status / Next Gate

لم يعد هناك blocker لتسليم Phase 2C؛ تم حل مسار التسليم والـPR والدمج.

الخطوة التالية قبل إعلان Phase 2 مغلقة بالكامل:
- تنفيذ **Practical Manager Document Journey Validation** على `main` الحالي:
  1. upload document.
  2. save intake metadata.
  3. submit for review.
  4. review as incomplete/rejected أو approve حسب capability.
  5. التأكد من تحديث الحالة والبيانات والعرض بدون regression.

إذا نجحت الرحلة العملية، تُغلق Phase 2 رسميًا ثم يُنفذ Design Check للمهمة الوظيفية التالية من المرجع التشغيلي المعتمد.

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

## 7. Remaining MVP / Operational Backlog

### P0 — Practical Phase 2 Journey Validation
- upload → intake → submit-review → review/approve.
- validate both desktop and mobile only where UX is materially involved.
- no code changes unless a real blocker is found.

### P1 — Select next functional phase
بعد إغلاق Phase 2:
- Read-only Design Check من الوثيقة التشغيلية المعتمدة.
- تحديد أقل حزمة وظيفية تالية دون توسع.
- لا يبدأ التنفيذ قبل اعتماد التصميم.

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
