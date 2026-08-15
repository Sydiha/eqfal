# إقفال | EQFAL
# Project Progress & Status Report

آخر تحديث: 2026-08-15

## 1. الحالة التنفيذية المختصرة

المشروع مستمر في بناء Core MVP بعد اكتمال طبقة الهوية والجلسة، Fiscal Year API، والواجهة التشغيلية الأولى للسنوات المالية داخل Authenticated Shell.

المرجع الدائم والوحيد للكود المدمج:
- Repository: `Sydiha/eqfal`
- Branch: `main`
- آخر main معتمد: `df1c419906a280cc3057e7c99fce8c04530afbb8`

آخر مراحل مكتملة:
- Fiscal Year API / Application Integration — PR #12 merged.
- GitHub Actions CI foundation — PR #15 merged.
- Fiscal Years UI / Application Shell Integration — PR #14 merged.

المهمة التالية المقترحة:
- **Core MVP Security & Readiness Review** — Read-only أولًا.

Production:
- غير منشور.
- لا يجوز النشر دون موافقة صريحة.

---

## 2. Completed Features & Tasks

### 2.1 Bootstrap Core Foundation — DONE
- React + TypeScript + Vite + Mobile-first + RTL/LTR foundation.
- Node.js + TypeScript + Express Modular Monolith.
- Environment configuration، logging، health endpoint، PostgreSQL، migrations.
- PR #2 merged.

### 2.2 Data / Tenancy Foundation — DONE
- Company entity/repository وtenant-aware primitives.
- `company_id` foundation.
- migration advisory lock وfatal startup behavior عند failure.
- PR #3 merged.

### 2.3 Auth / Users Foundation — DONE
- Users repository/service.
- Password hashing/verification.
- SafeUser بدون `password_hash`.
- dummy bcrypt timing mitigation.
- PR #4 merged.

### 2.4 Memberships + Roles + Capabilities — DONE
- Global user + company memberships.
- company-scoped roles.
- operational capabilities.
- cross-company role protection.
- grant ceiling وself-escalation protection.
- PR #5 merged.

### 2.5 Fiscal Years + Initial Audit Foundation — DONE
- Fiscal Years company-scoped.
- `open` / `closed` states.
- `start_date < end_date`.
- overlap prevention داخل الشركة.
- transaction/advisory locking و`FOR UPDATE` للعمليات الحساسة.
- initial append-only application audit log مع recursive sanitization.
- PR #6 merged.

### 2.6 i18n + Company Switcher Foundation — DONE
- العربية default + English.
- RTL/LTR وdocument lang/dir.
- CompanyContext + allowed companies + companyKey.
- لا runtime placeholders.
- PR #7 merged.

### 2.7 Tool / Cost / Workflow Protocol — DONE
- GitHub/main هو المرجع الدائم.
- لا Replit Agent للبرمجة.
- لا Production دون موافقة.
- لا تكلفة تشغيلية جديدة دون موافقة.
- مهمة برمجية واحدة في كل مرة.
- PR #9 وPR #13 merged.

### 2.8 Auth / Session + Secure Company Switching — DONE
- Login فعلي باستخدام AuthService.
- Server-side sessions في PostgreSQL.
- opaque random token عبر HttpOnly Cookie مع DB hash.
- Session bootstrap/logout/invalidation.
- الشركات من Active Memberships + Active Companies فقط.
- Active Company محفوظة في Session الموثوقة.
- server-side membership/company validation عند switch.
- backend capability enforcement boundary.
- client session/company/capabilities ليست authority أمنية نهائية.
- PR #10 merged.

### 2.9 Fiscal Year API / Application Integration — DONE
Endpoints الحالية:
- `GET /api/fiscal-years`
- `POST /api/fiscal-years`
- `PATCH /api/fiscal-years/:id`
- `POST /api/fiscal-years/:id/close`

Capabilities:
- `fiscal_year.view`
- `fiscal_year.manage`

الضوابط:
- الشركة تؤخذ من authenticated Session فقط.
- client لا يمرر `company_id` كمرجع authority.
- GET يتطلب view، والعمليات المعدلة تتطلب manage.
- actorUserId من Session.
- cross-company lookup يعطي safe not-found semantics.
- business/state conflicts تعالج بصورة آمنة.
- PR #12 merged.

### 2.10 Fiscal Years UI / Authenticated Shell — DONE
- Fiscal Years أصبحت أول شاشة تشغيلية بعد Login.
- Header بسيط: EQFAL + Company Switcher + Language + Logout.
- list/create/edit/close.
- capability-aware UX.
- closed years غير قابلة للتعديل في الوظائف الحالية.
- strict client range validation: start < end.
- no `company_id` في payloads.
- company switch يمسح stale company-scoped UI عبر remount/refetch.
- 401 يعيد Login state.
- Arabic/English strings.
- PR #14 merged.

### 2.11 GitHub Actions CI — DONE كأساس تحقق دائم
على PR إلى `main` وعلى push إلى `main`:
- dependency install.
- TypeScript.
- Tests.
- Build.

الضوابط:
- standard runner فقط.
- timeout محدود.
- read-only contents permission.
- no Production deployment.
- PR #15 merged.

ملاحظة:
- package-lock يحتوي registry URLs قديمة من Replit.
- CI يطبعها مؤقتًا إلى npm public registry داخل Runner فقط قبل install.
- تنظيف lockfile نفسه بند تشغيلي مستقل.

---

## 3. Security / Reliability Fixes المحسومة
- DB/migration critical failures أصبحت fatal.
- migration advisory lock.
- `company_id` وحده ليس Authorization.
- auth timing mitigation للبريد غير الموجود.
- Grant Ceiling + self escalation protection.
- Fiscal Year concurrency locking.
- sensitive audit sanitization.
- Company Switcher بدون placeholders/stale tenant state.
- Active Company أصبحت server-trusted session context.
- cross-company capability drift protection.
- generic backend error boundary لمسارات Auth.
- Fiscal Year HTTP boundary company/capability enforced.
- stale company UI لا يبقى ظاهرًا أثناء switch.

---

## 4. Current Status

لا توجد مهمة برمجية مفتوحة حاليًا.

آخر عمل مدمج:
- PR #14 — Fiscal Years UI / Application Shell Integration.

آخر main معتمد:
- `df1c419906a280cc3057e7c99fce8c04530afbb8`.

النقطة التالية المقترحة:
- **Core MVP Security & Readiness Review**.

يجب أن تبدأ بـ Read-only Design Check قبل أي تعديل.

---

## 5. Remaining MVP Backlog / TODO

### Priority P0 — Core Security & Identity

#### 5.1 Auth / Session Integration — DONE
- Login/session/bootstrap/logout ✅
- authenticated user من Server-side source ✅
- current-session invalidation ✅
- auth middleware boundary ✅

#### 5.2 Authorized Companies / Active Company — DONE
- active memberships + active companies فقط ✅
- server-side company switch validation ✅
- active company داخل trusted session ✅
- client company values ليست authority ✅

#### 5.3 Capability Enforcement — DONE كأساس
- backend enforcement boundary ✅
- DB-backed capability evaluation ✅
- Fiscal Year endpoint capabilities ✅

### Priority P1 — Core MVP Completion

#### 5.4 Fiscal Year API / Application Integration — DONE
- API/application boundary ✅
- tenant-safe read/write ✅
- audit/locking reuse ✅
- cross-company protection ✅

#### 5.5 Initial Application Shell — DONE للحد الأدنى المعتمد
- login state ✅
- authenticated shell ✅
- Company Switcher ✅
- Language Switcher ✅
- Logout ✅
- أول module فعلي: Fiscal Years ✅
- mobile-first + RTL/LTR ✅

لا يشمل بعد:
- sidebar كامل.
- dashboard مالي.
- router framework موسع.
- design system جديد.

#### 5.6 Core MVP Security & Readiness Review — NEXT
Read-only أولًا، ثم لا تنفيذ إلا للـblockers الحقيقية المعتمدة.

المراجعة المطلوبة:
- auth/session invalidation edge cases.
- cross-company read/write عبر HTTP boundary.
- Fiscal Year capability coverage.
- inactive membership/company behavior.
- company-switch stale-state behavior.
- 401/403/404/409 semantics.
- audit coverage للأحداث الحساسة الحالية.
- CI behavior كمصدر تحقق مستقل.

المخرجات المطلوبة:
- ما يعمل فعليًا.
- gaps أو blockers فقط.
- الاختبارات الناقصة إن وجدت.
- أقل حزمة إصلاح ممكنة.
- قرار Go/No-Go للانتقال للوحدة التشغيلية التالية.

### Priority P2 — Core Operational Readiness

#### 5.7 Portable Dependency Lockfile
- إزالة registry URLs الخاصة بـReplit من `package-lock.json` بصورة دائمة.
- الحفاظ على نفس dependency graph قدر الإمكان.
- تشغيل CI بعد التغيير.
- لا تغيير Business Logic.

#### 5.8 Audit Coverage Review
- Audit فقط للعمليات الحساسة ذات القيمة المحاسبية/الإدارية.
- يراجع coverage عند كل module جديد.

#### 5.9 Documentation Refresh
- بعد كل حزمة جوهرية: `TODO.md`, `DECISIONS.md`, `RECAP_SESSION.md`.
- `SECURITY_AND_TENANCY_CHECKLIST.md` عند تغير حالة أمنية فعلية.

#### 5.10 Staging Validation
قبل أي Production مستقبلًا:
- migrations على Staging.
- Auth/Tenancy/Permissions smoke tests.
- Build + smoke test.
- secrets/environment isolation review.
- Production ممنوع حتى الموافقة الصريحة.

---

## 6. Deferred — خارج Core MVP الحالي
- Accounting periods / Month / Quarter close.
- Reopen workflow الكامل.
- Bank transactions / reconciliation.
- OCR.
- Purchase/Sales invoices.
- Expenses workflow.
- Unknown transfers.
- Personal withdrawals.
- Advances.
- Manpower payroll.
- VAT reconciliation.
- Zakat.
- full year-end close workflow.
- Financial statements / Qawaem output.
- Notifications / email alerts.
- E-invoicing / external ERP integrations.
- Native mobile application.
- Paid AI/APIs.
- Permanent workers/queues.
- MFA/OAuth حتى تظهر حاجة معتمدة.
- Password reset / logout-all-devices حتى مرحلة إدارة الحسابات.

---

## 7. Definition of Done — المهمة التالية
مهمة **Core MVP Security & Readiness Review** لا تعتبر مكتملة إلا إذا:
- تبدأ Read-only فقط.
- تراجع latest `main` وليس branch قديم.
- لا تعدّل الكود أثناء Design Check.
- توثق coverage الحالي لـAuth/Tenancy/Capabilities/Fiscal Year HTTP/UI.
- تحدد gaps أو blockers بأدلة من الكود/الاختبارات.
- لا توسع النطاق إلى module جديد.
- إذا لم توجد blockers: تصدر Go للمرحلة التالية بدون تغييرات شكلية.
- إذا وجدت blockers: تحدد أقل حزمة تنفيذ مستقلة قبل أي code change.
