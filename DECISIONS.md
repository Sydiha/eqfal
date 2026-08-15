# DECISIONS

## 2026-08-14 — المرجع الدائم
**القرار:** `GitHub/main` هو المرجع الدائم والوحيد للكود والحالة المدمجة.

**السبب:** منع الاعتماد على Workspace مؤقت أو ذاكرة المحادثة وضمان إمكانية استئناف العمل من المستودع.

## 2026-08-14 — دور Replit
**القرار:** Replit يُستخدم كبيئة تشغيل/Preview عند الحاجة بأقل استهلاك ممكن، وليس كمرجع دائم للمشروع.

**السبب:** ضبط التكلفة وتقليل الارتباط بالمنصة.

## 2026-08-14 — Staging وProduction
**القرار:** اعتماد بيئتين منفصلتين في البيانات والأسرار: Staging للاختبار وProduction للبيانات الحقيقية.

**الضوابط:**
- لا مشاركة لقواعد البيانات أو الأسرار أو ملفات Production مع Staging.
- الأصل استخدام بيانات تجريبية في Staging، ولا تستخدم بيانات Production إلا بعد إخفاء/تنقيح مناسب.
- كل Migration أو ميزة تمر Staging ثم الاختبار والمراجعة والموافقة قبل Production.
- لا Production دون موافقة صريحة.
- الفصل يحقق بأقل تكلفة ممكنة؛ لا يشترط شراء خادمين دائمين.

## 2026-08-14 — سياسة التكلفة
**القرار:** الهدف صفر تكلفة إضافية قدر الإمكان فوق الأدوات والاشتراكات الحالية. لا خدمة مدفوعة أو API مدفوع أو Credits إضافية أو ترقية خطة دون موافقة صريحة.

## 2026-08-14 — نمط التنفيذ
**القرار:** مهمة برمجية واحدة فقط في كل مرة، مع branch/PR ومراجعة قبل الدمج إلى `main`.

---

## 2026-08-15 — فصل المستخدم العالمي عن عضوية الشركة
**القرار:** المستخدم كيان عالمي، ووصوله لكل شركة يتم عبر Membership مستقلة.

**النتائج:**
- المستخدم الواحد يمكن أن يرتبط بعدة شركات.
- تعطيل عضوية في شركة لا يعطل الحساب عالميًا.
- الأدوار والصلاحيات التشغيلية تُقيّم ضمن سياق الشركة.
- أي عملية Tenant-scoped تتحقق من المستخدم + الشركة + العضوية.

## 2026-08-15 — Roles company-scoped وCapabilities تشغيلية
**القرار:** Roles مرتبطة بشركة محددة، بينما Capabilities تمثل صلاحيات تشغيلية صريحة ولا تستبدل بصلاحيات صفحات واجهة.

**الضوابط:**
- لا ربط Membership بدور من شركة أخرى.
- Backend هو المرجع في enforcement.
- إخفاء زر/صفحة في Frontend ليس Authorization.
- كل عملية حساسة تحدد Capability مناسبة.

## 2026-08-15 — Grant Ceiling إلزامي
**القرار:** من يمنح Roles/Capabilities لا يستطيع منح أعلى من قدراته الفعلية داخل الشركة المستهدفة.

**الضوابط:**
- منع self-escalation.
- لا قبول company context خاص بالمانح من Client.
- حساب السقف يعتمد على سياق موثوق وبيانات Backend.

## 2026-08-15 — `company_id` وحده غير كافٍ لعزل الشركات
**القرار:** وجود `company_id` شرط أساسي لكنه ليس Authorization كاملًا.

**كل وصول Tenant-scoped يتحقق عند الحاجة من:**
1. authenticated user.
2. active membership.
3. trusted active company context.
4. required capability.
5. company-scoped query.

## 2026-08-15 — حماية Fiscal Year من السباقات المتزامنة
**القرار:** العمليات الحساسة على Fiscal Years تستخدم transaction واحدة مع locking مناسب.

**التنفيذ:**
- transaction-scoped advisory lock في سيناريوهات overlap.
- `SELECT ... FOR UPDATE` عند update/close.
- status check + write + audit داخل نفس transaction/client.

## 2026-08-15 — Audit Log أولي مع Sanitization مركزي
**القرار:** الأحداث الحساسة تسجل في Audit Log مع before/after عند الحاجة، وتنقى البيانات الحساسة مركزيًا قبل التخزين.

**الضوابط:**
- لا passwords أو secrets.
- Sanitization recursive للـobjects والـarrays.
- sensitive-key matching case-insensitive.
- state change وaudit ذريًا داخل نفس transaction عندما تكون العملية حساسة.

**ملاحظة:** Audit Log الحالي append-only على مستوى التطبيق؛ لا يوصف بأنه DB-immutable دون enforcement صريح في قاعدة البيانات.

## 2026-08-15 — Fiscal Years قبل Accounting Periods
**القرار:** Core MVP يثبت Fiscal Years أولًا، ولا يبني Accounting periods أو VAT periods أو reopen workflow في هذه المرحلة.

## 2026-08-15 — العربية default مع دعم الإنجليزية
**القرار:** النظام ثنائي اللغة من النواة: Arabic + English، والعربية default.

**الضوابط:**
- Arabic = RTL.
- English = LTR.
- اختيار اللغة محلي في الواجهة.
- `document.lang` و`document.dir` يتزامنان مع اللغة.
- Business Logic لا تعتمد على اللغة.

## 2026-08-15 — Company Switcher ليس Security Boundary
**القرار:** Company Switcher مسؤول عن UX وحالة الشركة النشطة في الواجهة، وليس آلية حماية نهائية.

**الضوابط:**
- يعرض allowed companies من مصدر موثوق.
- لا runtime demo/placeholder companies.
- Backend يعيد التحقق من العضوية والشركة عند switch وكل request حساس.

## 2026-08-15 — مزامنة Active Company مع تغير العضويات
**القرار:** إذا تغيرت الشركات المسموحة، يعاد ضبط Active Company بصورة آمنة.

**السلوك:**
- تبقى الشركة الحالية إذا ما زالت مسموحة.
- إذا لم تعد مسموحة ينتقل النظام إلى fallback مسموح.
- same-company switch = no-op.
- تغيير الشركة الحقيقي يعيد تهيئة company-scoped state.

## 2026-08-15 — لا بيانات Placeholder للشركات في Runtime
**القرار:** لا تستخدم شركات وهمية داخل Runtime Company Switcher.

## 2026-08-15 — استخدام scripts الرسمية فقط للتحقق
**القرار:** نتائج TypeScript/Tests/Build المعتمدة في تقارير المشروع تأتي فقط من scripts الرسمية المعرفة في المستودع أو من CI الذي يشغل هذه scripts نفسها.

## 2026-08-15 — إيقاف Replit Agent عن البرمجة
**القرار:** لا يستخدم Replit Agent لتعديل كود مشروع إقفال.

**تقسيم المسؤولية:**
- Chat + GitHub: إدارة المشروع، Design Check، مراجعة، PR/CI/merge ضمن الأدوات المتاحة.
- Codex: تنفيذ برمجي عند الحاجة وفق المهمة المعتمدة.
- Replit: Runtime/Preview يدوي فقط عند الحاجة.

## 2026-08-15 — قاعدة توثيق رصيد الإنجاز
**القرار:** بعد كل حزمة جوهرية أو قرار معماري/تشغيلي مؤثر، يحدث رصيد المشروع قبل بدء المهمة التالية.

**الملفات الأساسية:**
- `TODO.md`
- `DECISIONS.md`
- `RECAP_SESSION.md`
- `SECURITY_AND_TENANCY_CHECKLIST.md` عند تغير حالة أمنية فعلية.

## 2026-08-15 — Server-side Session بدل JWT في Client
**القرار:** Core MVP يستخدم Server-side sessions في PostgreSQL مع opaque random token في HttpOnly Cookie، ولا يستخدم JWT في localStorage كمرجع أمني.

**الضوابط:**
- DB تخزن hash للتوكن وليس التوكن الخام.
- Session لها expiry ويمكن إبطالها Server-side.
- Logout يبطل Session الحالية ويمسح Cookie.
- user/session المعطل أو المنتهي لا يمنح وصولًا.

## 2026-08-15 — Active Company محفوظة في Session ويعاد التحقق منها
**القرار:** `activeCompanyId` جزء من Session الموثوقة وليس قيمة Client مستقلة تحدد Tenant authority.

**الضوابط:**
- allowed companies من Active Memberships + Active Companies.
- switch يعاد التحقق منه Server-side.
- failed switch لا يغير الشركة الحالية.
- لا client-controlled `company_id` يتجاوز الشركة النشطة في المسارات الحساسة.

## 2026-08-15 — Capabilities لا تُجمّد كمرجع أمني داخل Session
**القرار:** capabilities قد تعاد للواجهة لتحسين UX، لكن Backend يعتمد على الحالة الحالية في DB عند enforcement.

**النتيجة:** تغيير Membership/Role/Capabilities ينعكس في الطلبات اللاحقة دون انتظار انتهاء Session.

## 2026-08-15 — Fiscal Year HTTP/Application Boundary
**القرار:** Fiscal Year endpoints تعتمد authenticated Session وActive Company الموثوقة ولا تقبل company context من Client كمرجع أمني.

**الضوابط:**
- `fiscal_year.view` للقراءة.
- `fiscal_year.manage` للإنشاء/التعديل/الإقفال.
- cross-company lookup لا يكشف وجود سجل شركة أخرى.
- Domain service الحالي يبقى مصدر business rules والlocking/audit.

## 2026-08-15 — Fiscal Years هي أول شاشة تشغيلية بعد Login
**القرار:** أول authenticated application shell يبقى minimal ويعرض Fiscal Years كأول module فعلي، بدون Dashboard/Sidebar/Router framework موسع قبل الحاجة.

**السبب:** تثبيت تدفق Auth → Company → Capability → Business Module بأقل تعقيد.

## 2026-08-15 — GitHub Actions CI أصبح طبقة التحقق الدائمة
**القرار:** اعتماد GitHub Actions Workflow بسيط لكل PR إلى `main` ولكل push إلى `main` لتشغيل dependency install ثم TypeScript ثم Tests ثم Build.

**الضوابط:**
- standard hosted runner فقط.
- timeout محدود.
- read-only repository contents permission.
- concurrency cancellation للتشغيلات المتجاوزة.
- لا Production deployment داخل CI.
- لا خدمة مدفوعة أو Runner مدفوع جديد دون موافقة.

**السبب:** جعل التحقق مربوطًا بنفس commit/PR الموجود على GitHub بدل الاعتماد على Workspace محلي قد يكون ناقص dependencies أو مختلف البيئة، وتقليل النقل اليدوي بين Chat وCodex.

**هذا القرار لا يتعارض مع قرار «لا CI مدفوع» السابق:** الاعتماد الحالي مشروط بعدم إنشاء تكلفة تشغيلية جديدة؛ إذا احتاج CI مستقبلًا دفعًا أو توسعًا مدفوعًا، يجب التوقف وطلب موافقة.

## 2026-08-15 — لا يعتمد المستخدم كوسيط نقل يدوي بين Chat وCodex
**القرار:** النسخ/اللصق المتكرر للـpatches والـSHAs والأوامر بين Chat وCodex ليس workflow طبيعيًا للمشروع.

**السلوك المستهدف:**
- GitHub PR هو handoff الدائم.
- CI هو مصدر التحقق التنفيذي.
- Chat يقرأ PR/CI مباشرة من GitHub ويحدد القرار أو الإصلاح.
- يطلب تدخل المستخدم فقط عند قرار/موافقة أو عندما لا توجد أداة تقنية بديلة فعلية.

## 2026-08-15 — تطبيع Registry داخل CI حل مؤقت فقط
**القرار:** لأن `package-lock.json` الحالي يحتوي URLs داخلية قديمة من Replit، يقوم CI حاليًا بتطبيعها إلى `registry.npmjs.org` داخل Runner فقط قبل `npm ci`.

**الحد:** هذا ليس الحل النهائي للـlockfile ولا يغير الملف المدمج نفسه.

**المتابعة:** تنظيف Portable Dependency Lockfile يتم كمهمة تشغيلية مستقلة، مع الحفاظ على dependency graph قدر الإمكان ونجاح CI بعده.

---

## 2026-08-15 — Secure Document Storage Foundation
**القرار:** تخزن PostgreSQL metadata فقط للمستندات، بينما binary files تمر عبر replaceable Storage Adapter؛ لا BLOBs داخل PostgreSQL ولا permanent public URLs ضمن التدفق الحالي.

**الضوابط:**
- file retrieval company-scoped ومصادق عليه.
- storage key ليس client authority.
- file validation قبل القبول: type/extension/signature/size.
- SHA-256 يحسب Server-side.

## 2026-08-15 — فصل Document Review عن Document Approval
**القرار:** `document.review` و`document.approve` صلاحيتان مستقلتان ولا يجوز دمجهما.

**النتيجة:**
- `document.review` يسمح فقط بـ`incomplete` و`rejected` من `needs_review`.
- `document.approve` يسمح فقط بـ`approved` من `needs_review`.
- UI يعكس الفصل للـUX، لكن Backend هو المرجع الأمني النهائي.

## 2026-08-15 — Document Review state machine
**القرار:** التدفق الحالي المغلق هو:
- `uploaded -> needs_review` عبر `document.upload`.
- `needs_review -> incomplete/rejected` عبر `document.review`.
- `needs_review -> approved` عبر `document.approve`.

**الضوابط:**
- mutations تستخدم Same-Origin + Auth + trusted Active Company.
- lookup مقيد بـ`document id + company id` مع `FOR UPDATE` داخل transaction.
- cross-company/not-found = safe 404.
- stale/invalid transition = 409.
- `review_note` max 500؛ required لرفض/نقص، optional للاعتماد.
- submit-review لا يضع reviewer metadata؛ final review decision فقط يضع reviewer/time/note.
- كل transition حساس له Audit action مستقل.

## 2026-08-15 — Design Check عقد تنفيذ ملزم
**القرار:** أي Design Check أو implementation specification معتمدة هي contract ملزم حرفيًا، وأي خروج عن النطاق المعتمد defect وليس improvement.

**الضوابط:**
- لا تغيير architecture/security/capabilities/API/state transitions/validation/limits/schema/UX دون موافقة.
- إذا ظهر تعارض أو استحالة تقنية، يتوقف التنفيذ قبل الانحراف ويتم التصعيد للمستخدم.
- نجاح TypeScript/Tests/Build لا يعوض عدم مطابقة التصميم.

## 2026-08-15 — One-Shot Rule
**القرار:** بعد اعتماد Design Check، يرسل إلى Codex أمر تنفيذ واحد فقط، شامل ومغلق.

**يجب أن يتضمن:** scope، out-of-scope، API، capabilities، schema، transitions، validation، error semantics، tests، Definition of Done.

**الممنوع:** drip-feeding للمتطلبات أو إعادة تصميم المهمة أثناء التنفيذ.

## 2026-08-15 — Zero-Loop Rule
**القرار:** بعد التنفيذ الأول يسمح corrective implementation pass واحد فقط إذا وجد blocker حقيقي.

**الحكم:** إذا احتاجت المهمة corrective pass ثانيًا، تتوقف المهمة فورًا بدل الدخول في fix/review loop إضافية.

**كذلك:** النقل اليدوي المتكرر للـterminal/logs/patches/SHAs عبر المستخدم ليس workflow مقبولًا؛ يفضل GitHub PR + CI + direct inspection.

## 2026-08-15 — معيار القبول
**القرار:** لا يعتمد أي implementation من ملخص Codex أو أي agent summary وحده.

**Definition of acceptance:**
1. مراجعة diff الحقيقي.
2. مطابقة Design Check بندًا بندًا.
3. نجاح الاختبارات/TypeScript/Build المطلوبة.
4. نجاح GitHub CI على نفس الـPR/commit المراد دمجه.
5. لا Merge إذا بقي blocker غير محسوم.
