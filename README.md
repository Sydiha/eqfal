# إقفال | EQFAL · Financial Close & Operations

⚠️ Last Updated: 2026-10-03
Reference SHA at time of reconciliation — not current HEAD: 181f37ed60920cdf406155049173a9924272c0bb
Status: Active Development (Phase 14–15)

منصة داخلية متعددة الشركات للإدارة والإقفال المالي، تُبنى كنواة صغيرة وآمنة واقتصادية وقابلة للنقل والتوسع.

## Current Status

Phase 14 (Full-Cycle Validation): IN PROGRESS
Phase 15 (System-wide UI/UX): PARTIALLY MERGED
Recent merges: #305 (2026-09-30), #309 (2026-10-01), #313 (2026-10-02)
Open PRs: #214, #229, #307
See: docs/EXECUTION_ROADMAP.md for full roadmap
See: RECAP_SESSION.md for latest session state

## الحالة الحالية

- المرجع الدائم للكود: `GitHub/main`.
- بيئة التنفيذ الأولية: Replit مع الحفاظ على قابلية النقل.
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
