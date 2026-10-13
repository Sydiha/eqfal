# Recurring invoices (sales and purchase)

Migration 073 + `server/src/modules/invoices/recurring-invoice.*`. Generates **draft** invoices only.

- **Never** submits, approves, numbers, posts journals, creates obligations/VAT reviews, settles or sends. Generated drafts enter the normal workflow (`origin = 'recurring'`).
- **Capability:** `invoice.recurring` (explicit-grant-only, no role holds it). Reading needs `invoice.view`. Manual "generate now" also needs `invoice.create`.
- **Schedule:** monthly / quarterly / annual from `start_date`; occurrences keep the start day and clamp to short months without drifting (31 Jan -> 28 Feb -> 31 Mar). `end_date` optional; the schedule ends itself after the last occurrence.
- **Idempotency (database):** `invoices_recurrence_occurrence_uidx` (062) allows one invoice per (company, template, occurrence date); each generation also holds the template row lock (`FOR UPDATE SKIP LOCKED`), so concurrent runs cannot duplicate.
- **Scheduler:** in-process, no external service/cost; runs 30 s after start and hourly (`RECURRING_INVOICE_SCHEDULER=off` disables). The manual "Generate due drafts now" action uses the same code.
- **Decisions to confirm:** missed occurrences of an *active* schedule are created oldest-first (max 12 per run) with their own scheduled date; *resume* after a pause does **not** back-fill (continues from the first date on or after today); `issue_date = tax_point_date = scheduled date`; drafts are created by the template's creator (so separation of duties still blocks that user approving them); a generation error (e.g. stale VAT rate) is recorded on the schedule and retried, never skipped.
- Rollback: see header of `073_recurring_invoice_templates.sql`.
