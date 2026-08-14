# ARCHITECTURE

## النمط المعماري
- Frontend: React + TypeScript، Mobile First، RTL/LTR.
- Backend: Node.js + TypeScript ضمن Modular Monolith.
- Database: PostgreSQL كخيار افتراضي معتمد ما لم يظهر سبب تقني موثق لتغييره.
- Migrations: منظمة، مراجعة، وتُطبّق على Staging قبل Production.
- Config: عبر Environment Variables؛ يمنع hardcode الخاص بـReplit في منطق الأعمال.
- Observability: Structured logs + health endpoint أولًا؛ لا SaaS مدفوع في MVP.
- Background processing: لا Workers/Queues دائمة في MVP إلا إذا ظهرت حاجة مثبتة.

## Tenancy
- العزل مبني على `company_id` مع relationship checks على مستوى Backend.
- لا يكفي إخفاء الصفحات؛ كل API وقراءة وكتابة وبحث وتصدير يجب أن يتحقق من الشركة والعضوية والصلاحية.
- المستخدم قد يرتبط بعدة شركات بعضويات مستقلة.

## Auth وPermissions
- Auth قابل للنقل ولا يعتمد على منصة الاستضافة في منطق الصلاحيات.
- Roles وCapabilities منفصلة لكل شركة.
- لا Defaults في قاعدة البيانات تمنح صلاحيات أعلى من سقف المنشئ أو الإدارة.

## قابلية النقل
- أوامر `build` و`start` قياسية وموثقة.
- PostgreSQL ومهاجرات قياسية.
- Auth وStorage خلف حدود واضحة وقابلة للاستبدال.
- لا منطق أعمال يعتمد على خدمة Replit خاصة.
- يجب أن يمكن نقل التطبيق والبيانات لاحقًا إلى سيرفر خاص بأقل تعديل ممكن.

## التوسع المستقبلي
حدود واضحة تسمح مستقبلًا بإضافة e-invoicing، ERP/Accounting integrations، APIs، البنوك والجهات الخارجية دون إعادة بناء النواة. هذه الوحدات خارج MVP الحالي.