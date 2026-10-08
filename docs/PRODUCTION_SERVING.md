# PRODUCTION_SERVING — تقديم الواجهة والـ API من أصل HTTPS واحد

## ما الذي تغيّر
في الإنتاج فقط (`NODE_ENV=production`) يقدّم Express مجلد `client/dist` بعد مسارات `/api`:
- `/api/*` لا يُمسّ: نفس المسارات والمصادقة وفحص Origin (CSRF) والصلاحيات، ويحتفظ بهيدرز API الصارمة (`default-src 'none'`، `no-store`).
- الملفات الثابتة: `/assets/*` (أسماء Vite مُجزّأة بالهاش) تُخدم `immutable` لسنة؛ باقي الملفات (`eqfal-mark.svg`) ساعة؛ `index.html` يُخدم `no-cache` (يُعاد التحقق منه دائماً).
- مسارات الواجهة (`/fiscal-years/...` وغيرها بلا امتداد ملف) تُرجع `index.html` (SPA fallback). ملف بامتداد غير موجود يُرجع 404، لا `index.html`.
- CSP للواجهة فقط (غير `/api`): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. `unsafe-inline` للأنماط فقط (Mantine)؛ السكربتات `self` فقط. بقية الهيدرز (HSTS، nosniff، X-Frame-Options DENY…) تبقى كما هي.
- التطوير لا يتغير: `npm run dev` (Vite + بروكسي `/api`).

## البناء والتشغيل
```
npm ci
npm run build        # orchestrator + server/dist + client/dist
NODE_ENV=production DATABASE_URL=... APP_PUBLIC_ORIGINS=https://<النطاق> TRUST_PROXY=<قفزات> npm start
```
- الخادم يرفض الإقلاع في الإنتاج إذا لم يجد `client/dist/index.html`. يمكن تغيير المسار بـ `FRONTEND_DIST_DIR` (اختياري).
- إن اختفى `index.html` أثناء التشغيل: صفحات الواجهة تُرجع `503 {"error":"Frontend build unavailable"}` والـ API يبقى يعمل.
- منفذ واحد (`PORT`، الافتراضي 3001) يخدم الواجهة والـ API. لا حاجة لـ `vite preview` ولا لبروكسي.
- باقي المتغيرات المطلوبة في الإنتاج كما في `.env.example`.

## ملاحظات لـ Replit (فحص فقط، لا تفعيل)
- `.replit` الحالي: `run = "npm run dev"` ومنفذان (5173، 3001) وبلا قسم `[deployment]`. هذا وضع تطوير.
- لنشر مبني على هذا التغيير يلزم لاحقاً (بموافقة المالك): أمر build = `npm ci && npm run build`، وأمر run = `npm start`، ومنفذ خارجي واحد يشير إلى `PORT`، وSecrets الإنتاج. لم يُعدَّل `.replit` ولم يُنشر شيء.
- [غير قابل للتحقق من المستودع] نوع النشر، التخزين الدائم لـ `DOCUMENT_STORAGE_DIR`/`BANK_STORAGE_DIR`، وقيمة `TRUST_PROXY` الصحيحة.

## معروف ولم يُعالج هنا
- معاينة PDF داخل `<iframe src="/api/documents/:id/file">` قد تُمنع بسبب `X-Frame-Options: DENY` و`frame-ancestors 'none'` على استجابات API (قائم قبل هذا التغيير). المعالجة المقترحة: استثناء ضيق لهذا المسار فقط بـ `SAMEORIGIN`. تحتاج قرار المالك.
