# إقفال | EQFAL
# Project Progress & Status Report

آخر تحديث: 2026-08-15

## 1. الحالة التنفيذية المختصرة

مشروع **إقفال | EQFAL** مستمر في بناء Core MVP. تم إغلاق ودمج الأساسات الأمنية والتشغيلية الأساسية، Phase 2A لرفع المستندات الآمن، Phase 2B لتدفق مراجعة المستندات، وحزمة Documentation Recovery.

المرجع الدائم والوحيد للكود المدمج:
- Repository: `Sydiha/eqfal`
- Branch: `main`
- المرجع الحالي دائمًا: latest GitHub `main`.

آخر الأعمال المدمجة:
- PR #20 — Phase 2B Document Review Workflow.
- PR #21 — Documentation Recovery through Phase 2B.

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
- Documentation Recovery through Phase 2B.

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
- Documents UI الأساسية.

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
- company-scoped lookup + `SELECT ... FOR UPDATE` داخل transaction.
- safe 404 للـcross-company/not-found.
- 409 للحالة غير الصالحة/stale transition.
- `review_note` بحد 500 حرف.
- سبب إلزامي لـ`incomplete` و`rejected`.
- `approved` يسمح بملاحظة اختيارية.
- `submit-review` لا يملأ reviewer metadata.
- Audit actions: `document.submit_review`, `document.mark_incomplete`, `document.reject`, `document.approve`.

Verification:
- Phase 2B اجتازت GitHub Actions CI على PR #20: Install + TypeScript + Tests + Build.

### 3.3 Phase 2C — Manager Document Intake — BLOCKED ON DELIVERY

Design Check: **APPROVED**.

Codex reported implementation completed on local branch:
- branch: `phase-2c-manager-document-intake`
- local commit: `facd60c49aaf5b3f4c5010d0daddffd5bd713f07`
- reported tests: server 155 passed, client 60 passed.
- reported TypeScript/build/`git diff --check`: passed.
- reported out-of-scope changes: none.

However, this implementation is **not accepted and not merged** because Chat/GitHub cannot inspect the real diff: the Codex environment had no configured GitHub remote and could not push the branch. Codex also could not provide a transferable file artifact through the current interaction path.

Important:
- This is a **delivery/tooling blocker**, not a confirmed code defect.
- No Single Fix has been consumed for Phase 2C.
- No PR exists for Phase 2C.
- `main` remains unchanged by Phase 2C.
- Phase 2 is **not closed** until Phase 2C is reviewable on GitHub, accepted, CI-tested, and merged.
- Do not reimplement or reconstruct Phase 2C from memory/summary as a substitute for reviewing the real diff.

---

## 4. Current Status

Current active blocker:
- **Codex → GitHub delivery path for Phase 2C.**

The user plans to return later to resolve this Codex file/remote delivery issue fundamentally. Until then:
- do not advance to Phase 3;
- do not claim Phase 2 closed;
- do not request repeated manual transfer of logs/patches/files from the user;
- preserve the approved Phase 2C Design Check and the reported local commit reference above.

---

## 5. Operating Rules — ACTIVE

- `GitHub/main` هو المرجع الدائم.
- Design Check المعتمد عقد تنفيذ ملزم.
- One-Shot Rule: بعد اعتماد التصميم، Codex يستلم أمر تنفيذ واحدًا شاملًا ومغلقًا.
- Zero-Loop Rule: يسمح بحد أقصى corrective pass واحد؛ الحاجة إلى تصحيح ثانٍ توقف المهمة فورًا.
- لا يعتمد المستخدم كوسيط نقل يدوي متكرر للـlogs/terminal/patches/files.
- القبول من diff الحقيقي + tests/CI + مطابقة Design Check، وليس من ملخص agent.
- مهمة برمجية واحدة فقط في كل مرة.
- لا Replit Agent للبرمجة.
- لا Production دون موافقة.
- لا تكلفة تشغيلية جديدة دون موافقة.

---

## 6. Remaining MVP / Operational Backlog

### P0 — Resolve Phase 2C delivery blocker
- Establish a reliable Codex-to-GitHub branch delivery path or another direct reviewable artifact path that does not make the user a manual transport layer.
- Review the actual Phase 2C diff against the approved Design Check.
- If PASS: open PR, run GitHub CI, merge after approval.
- If a genuine code blocker exists: only one Single Fix is allowed.

### P1 — Close Phase 2
After Phase 2C is accepted and merged:
- run the practical manager document journey validation.
- close Phase 2 only if the upload → intake → submit → review/approve flow passes.

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

لا تبدأ Phase 3 قبل:
1. حل مسار تسليم Phase 2C بحيث يصبح الـdiff الحقيقي قابلًا للمراجعة مباشرة.
2. Acceptance Review للـdiff الحقيقي.
3. Single Fix واحد كحد أقصى فقط إذا ظهر blocker برمجي.
4. PR + GitHub CI.
5. Merge بعد الموافقة.
6. نجاح الرحلة العملية لـPhase 2.
