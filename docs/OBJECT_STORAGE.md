# Object Storage (Replit App Storage) — Task 6C-2A

## تحذير: لا يُفعَّل في الإنتاج قبل Task 6C-2B
أداة النسخ الاحتياطي (`tools/backup`) **لا تغطي Object Storage بعد**. لذلك:
- الكود جاهز لكنه **غير مفعّل**: لم يُنشأ أي bucket ولم يُغيَّر أي إعداد في Replit/Staging/Production.
- في الإنتاج يرفض النظام الإقلاع بـ `STORAGE_BACKEND=object` ما لم يُضبط `OBJECT_STORAGE_BACKUP_SUPPORT_CONFIRMED=true` (مفتاح يقرره المالك بعد دمج 6C-2B ومراجعته).
- أمر `backup` يرفض العمل إذا كان `STORAGE_BACKEND=object` (بدل إنتاج أرشيفات فارغة).
- نتيجة ذلك عملياً: نشر Replit Production مع هذا الكود وبدون المفتاح **لن يقلع** (fail-closed مقصود) إلى أن يكتمل 6C-2B.

## السلوك
| البند | التفصيل |
|---|---|
| الواجهة | `StorageAdapter` (`put/get/delete`) دون تغيير؛ المحوّلان: `LocalStorageAdapter` و`ObjectStorageAdapter` |
| الاختيار | مكان واحد: `server/src/storage/storage.factory.ts` (المستندات، استيراد البنك، ومسار resume) |
| الافتراضي | `local` (التطوير والاختبارات) |
| `STORAGE_BACKEND=object` | يتطلب `OBJECT_STORAGE_BUCKET_ID` صريحاً (لا يُستخدم الـ bucket الافتراضي أبداً) |
| فصل البيئات | bucket صريح لكل بيئة + بادئة `prod/` أو `nonprod/` داخل الـ bucket |
| Replit Production | `REPLIT_DEPLOYMENT` (أو `NODE_ENV=production` مع `REPL_ID`) يُلزم `object`؛ وإلا يفشل الإقلاع. لا رجوع للقرص المحلي أبداً |
| الإقلاع | اختبار كتابة/قراءة/حذف لكائن تجريبي قبل `listen`؛ فشله يوقف الإقلاع |
| مفاتيح التخزين | `companyId/uuid` كما هي في قاعدة البيانات؛ الكائن يُخزَّن تحت `<env>/<kind>/<key>` |
| المفاتيح غير الآمنة | ترفض إلا الصيغة `UUID/UUID` |
| Write-once | `put` يرفض إن وُجد الكائن (`EEXIST`). الـ SDK لا يوفر شرطاً ذرياً، والمفاتيح UUID عشوائية فلا يُتوقع تصادم |
| الأخطاء | "No such object" فقط ⇒ `ENOENT` (404 كما اليوم). أي خطأ خدمة/شبكة/صلاحيات ⇒ `StorageUnavailableError` (500) ولا يُعرض كملف مفقود |
| السلامة | كل قراءة مستند/ملف بنك تتحقق من SHA-256 المسجل في PostgreSQL (`documents.sha256`, `bank_import_batches.file_sha256`)؛ عدم التطابق ⇒ `StorageIntegrityError` (500) ولا يُقدَّم الملف. يسري على Local أيضاً |
| Resume | خطأ تخزين/سلامة يعيد 500 (وليس 409 "cannot be resumed")؛ حقل `file_sha256` لا يظهر في الاستجابة |

## ما لم يُتحقق منه من منصة Replit
- سلوك الـ SDK الفعلي على Replit (رسائل الخطأ، الحدود): الاختبارات تستخدم عميلاً وهمياً بنفس دلالات `Result` للـ SDK `@replit/object-storage@1.0.0`. صيغة رسالة 404 ("No such object") مأخوذة من Google Cloud Storage ويجب تأكيدها عند أول تشغيل حقيقي؛ لو اختلفت فالنتيجة 500 وليس 404 (الاتجاه الآمن).
- التسعير والحدود وفصل bucket التطوير عن الإنتاج: يتحقق منها المالك قبل التفعيل.
