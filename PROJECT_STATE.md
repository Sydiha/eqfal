# EQFAL Project State

**Last updated:** 2026-10-12
**Repository:** Sydiha/eqfal
**Branch:** main

## Current Baseline
- **Last reconciled main:** `7013a2a8859f2984f0eec4790acb096a514eb36c` (squash of PR #426; GitHub `main` is the source of truth and may be ahead)
- **Last merge:** PR #426 — Invoice VAT V1 (sales invoices), merged 2026-10-12
- **CI status:** see GitHub checks on the merged commit (not restated here)

## Phase Status
| Phase | Status |
|-------|--------|
| 14 | IN PROGRESS / PARTIALLY VALIDATED |
| 15 | PARTIALLY MERGED / IN PROGRESS |

- Phase 14A merged. 14B is PARTIAL overall: row 5 PASS, rows 1–4 PARTIAL.
- Rows 6, 8, 12, 14 PARTIAL from owner-supplied external evidence (chat-reported, not repository evidence); rows 15, 16, 17, 19, 23 PARTIAL; row 11 NOT RUN. Reconciled via PR #320, #391, #392.
- **Per-row source of truth:** `docs/PHASE_14_FULL_CYCLE_VALIDATION_MATRIX.md` §9. GitHub `main` is the repository source of truth; Replit is runtime/manual verification only.

## Current Task
- **Status:** idle
- **Branch:** —
- **PR:** —

## Invoice VAT V1 (PR #426)
- **Status:** code-complete and merged to main; NOT deployed and NOT activated.
- Migration 066 has NOT been applied to the application database.
- Invoice approval remains disabled (no route, capability or grant). Purchases with VAT stay blocked.
- Evidence: isolated PostgreSQL 16 run 1518 passed / 1 skipped; CI `verify` green (PostgreSQL tests are skipped in CI). Replit same-SHA run not done.

## Invoice VAT V2 (purchases, PR #428) and V2.1 (recoverability)
- **V2:** merged to main (migration 067); purchase VAT = input VAT (VAT_INPUT asset debit per standard-rate group), immutable reviewed snapshot like V1.
- **V2.1:** PR open (migration 068), awaiting Owner review. Owner policy 2026-10-12, expense purchases only: non-recoverable input VAT is capitalized into the expense; partial recovery splits (recoverable -> VAT_INPUT, rest -> expense). Recovery is explicit per standard line (`fully_recoverable` | `non_recoverable` | `partially_recoverable` + explicit percent, 0 < p < 100); never inferred or defaulted. Asset purchases remain unsupported.
- Migrations 066, 067 and 068 have NOT been applied to the application database. Invoice approval remains disabled. Replit same-SHA run not done.

## Last Completed Task
- **Task:** Invoice VAT V1 (sales), PR #426, squash `7013a2a8859f2984f0eec4790acb096a514eb36c`. Earlier: Task 32 — Phase 14 evidence reconciliation (docs only), PRs #391 and #392
- **Recent merged UX/admin work:** Task 29 Admin & Audit usability (#383–#385); Task 30 Accounting master data UX (#386), 30A Chart of Accounts edit-mode fix (#387, #388), 30B bilingual account names (#389); Task 31 final visual cleanup (#390)
- **SHA:** `7013a2a8859f2984f0eec4790acb096a514eb36c`

## Open PRs
- None

## Open Blockers
- None confirmed

## Remaining Areas
- Unfinished Phase 14 runtime validation/evidence (rows NOT RUN or PARTIAL in the matrix).
- Stale GitHub Issue reconciliation/hygiene.
- Phase 13 conditional modules (deferred).
- Any residual Phase 15 items the Owner identifies (recent UX packs are merged; no residual list is recorded).

## Next Exact Step
- Owner review of the Invoice VAT V2.1 PR. Next development task (V3: credit/debit notes, cancellation) only when the Owner orders it.

## Attention Points
- Phase 15 readiness must be verified before future Phase 15 merges.

---
*Updated by Claude Code during task execution. Keep under 100 lines.*
