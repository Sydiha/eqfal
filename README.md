# إقفال — Eqfal · Financial Close & Operations

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
