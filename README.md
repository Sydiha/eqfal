# إقفال | EQFAL · Financial Close & Operations

⚠️ Last Updated: 2026-10-06
Reference SHA at time of reconciliation — not current HEAD: 468cfac20d8a01f567dd4104d5d4669ecc78d345
Status: Active Development (Phase 14–15)

منصة داخلية متعددة الشركات للإدارة والإقفال المالي، تُبنى كنواة صغيرة وآمنة واقتصادية وقابلة للنقل والتوسع.

## Current Status

Phase 14 (Full-Cycle Validation): IN PROGRESS / PARTIALLY VALIDATED (per-row status: docs/PHASE_14_FULL_CYCLE_VALIDATION_MATRIX.md §9)
Phase 15 (System-wide UI/UX): PARTIALLY MERGED / IN PROGRESS
Recent merges: Tasks 29–32 (Admin & Audit usability, Accounting master data UX, bilingual account names, final visual cleanup, Phase 14 evidence reconciliation), PRs #383–#392
See: docs/EXECUTION_ROADMAP.md for full roadmap
See: PROJECT_STATE.md and SESSION_HANDOFF.md for current state; RECAP_SESSION.md is a historical recap

## الحالة الحالية

- المرجع الدائم للكود: `GitHub/main`.
- بيئة التنفيذ الأولية: Replit للتحقق التشغيلي اليدوي فقط (وليست مرجع الكود) مع الحفاظ على قابلية النقل.
- لا Production منشور حاليًا.
- لا خدمات مدفوعة جديدة دون موافقة صريحة.

## مراجع المشروع

- `PROJECT_BRIEF.md`
- `ARCHITECTURE.md`
- `DECISIONS.md`
- `DEVELOPMENT_WORKFLOW.md`
- `SECURITY_AND_TENANCY_CHECKLIST.md`
- `RECAP_SESSION.md`
- `docs/ENVIRONMENTS.md`

> هذه المستندات تختصر القرارات التشغيلية اللازمة للعمل اليومي، بينما تبقى الوثيقة التشغيلية الشاملة المعتمدة المرجع الأعلى للنطاق والاتجاه.

---

## البنية / Structure

```
eqfal/
├── client/          # React 18 + TypeScript + Vite  (mobile-first, AR/EN, RTL/LTR)
├── server/          # Node.js + TypeScript  (Modular Monolith)
│   ├── migrations/  # SQL migrations (numbered, tracked via _schema_migrations)
│   ├── src/
│   │   ├── config/  # Central config from environment variables
│   │   ├── db/      # PostgreSQL pool + migration runner
│   │   ├── modules/ # Feature modules  (health, …)
│   │   └── shared/  # Structured logging (pino)
│   └── test/        # Smoke tests
└── package.json     # npm workspaces root
```

## الأوامر الموحدة / Commands

| الأمر | الوصف |
|---|---|
| `npm run dev` | تشغيل server + client معاً في وضع التطوير |
| `npm run typecheck` | فحص الأنواع (server + client) |
| `npm run test` | تشغيل الاختبارات (server + client) |
| `npm run build` | بناء (server + client) |
| `npm start` | تشغيل الـ server من dist |

## متغيرات البيئة / Environment Variables

انسخ `.env.example` إلى `.env` وعدّل القيم:

```bash
cp .env.example .env
```

## API

| Endpoint | الوصف |
|---|---|
| `GET /api/health` | حالة السيرفر والـ DB |

## قواعد المشروع

- **المرجع الوحيد للكود:** أحدث `main` في `Sydiha/eqfal`
- **قبل أي تعديل:** تحقق من `git status` + `HEAD == origin/main`
- **مهمة برمجية واحدة فقط في كل مرة**
