# إجراء حذف شركات الاختبار "FY Close" (قاعدة Replit التجريبية فقط)

الملف: `docs/ops/cleanup-fy-close-test-companies.sql` — ينفَّذ من Replit Shell بعد المراجعة. لا يُشغَّل على Production.

1. مراجعة (لا يغيّر شيئاً، ينتهي بـ ROLLBACK):
   `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f docs/ops/cleanup-fy-close-test-companies.sql`
2. إن ظهرت `BLOCKER` فلا تنفيذ (راجع المالك). إن نجحت المراجعة، دوّن عدد الشركات المطابقة N وقرّر حذف سجلات التدقيق.
3. التنفيذ:
   `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v commit=yes -v expect=N -v delete_audit=yes -f docs/ops/cleanup-fy-close-test-companies.sql`

الحماية: معاملة واحدة (كل شيء أو لا شيء)، الاسم مطابق تماماً `FY Close`، لا تعطيل triggers ولا constraints، يتحقق أن الشركات والمستخدمين والعضويات الأخرى والبيانات المرجعية لم تتغير.
