# EQFAL Project State

**Last updated:** 2026-10-30
**Repository:** Sydiha/eqfal
**Branch:** main

## Current Baseline
- **Verified main HEAD at update time:** `a5723c5` (PR #529, G8). GitHub `main` is the source of truth and may be ahead.
- **CI:** see GitHub checks on the commit (not restated; not re-run in this docs task).
- Repo migrations: 001–097 and 099–103 present (098 intentionally absent; reserved, NOT authorized).
- Vocabulary: Implemented / Verified / Partial / Deferred / Pending UAT / Unknown. Code merged + CI green is NOT functional UAT.

## Phase Status
| Phase | Status |
|-------|--------|
| B Users/Permissions | Implemented — Pending UAT |
| C Company setup & financial import | Implemented in part; Pending UAT; mode 3 and extended reconciliation Deferred |
| D Operational cycle | Implemented (G1–G3, G5, G8, R9, Q5) — all Pending UAT |
| E Reporting/Closing | Partial (G6 zakat, G7 concurrency inventory open) |
| F Final readiness | Not started |

## Delivered #506–#529 (all merged; implementation + CI only)
- #506 docs C6. #507 G5 (mig 099). #508 R9 (mig 100). #509 Q5 (mig 101). #510/#512 R9 follow-ups.
- #511 CI PG16 tools. #513 PR-2A error messages. #514 PR-2B stable 409 `code`.
- #515–#519 RTL/mobile/localization UI (PR-3A..4B). #520 docs sync through #519.
- #521 remaining UI fixes. #522 invoice mappings polish. #523 three UI defects (loading label, bank import errors, personal-payments status).
- #524 unified presentation on 8 banking/obligations screens. #525 custody document picker (replaces typed ID). #526 UX polish (year-first dates, custody closed-period error, picker a11y).
- #527 central period guards reject writes in a closed fiscal year (409 `FISCAL_YEAR_CLOSED`, no migration).
- #528 optional monthly closing policy per fiscal year (mig 102; `fiscal_years.monthly_close_policy`). **Implemented, UAT pending.** Annual close must not be weakened.
- #529 G8 optional labor-relationship classification on counterparties (mig 103; `counterparties.labor_relationship`). **Implemented, functional UAT pending.**

## Migration Status (089–103)
Replit TEST evidence: owner ran read-only queries; rows present in `_schema_migrations` (confirmed 2026-10-30). Other environments (Staging/Production): **UNKNOWN** unless noted.
| Mig | Feature | Replit TEST | Other envs |
|-----|---------|-------------|-----------|
| 088 | Bank statement reconciliation (G3) | Applied (memory, 2026-10-18) | UNKNOWN |
| 089 | Personal payments (G1/G2) | UNKNOWN | UNKNOWN |
| 090 | Accounting profile correction | UNKNOWN | UNKNOWN |
| 091 | Cutover historical supplements | UNKNOWN | UNKNOWN |
| 092 | Invoice adjustment numbering | UNKNOWN | UNKNOWN |
| 093 | Void approved unposted adjustment | UNKNOWN | UNKNOWN |
| 094 | Invoice account mapping capabilities | UNKNOWN | UNKNOWN |
| 095 | User display_name | UNKNOWN | UNKNOWN |
| 096 | Historical records | **Applied (confirmed)** | UNKNOWN |
| 097 | Opening-balance evidence exceptions | **Applied (confirmed)** | UNKNOWN |
| 098 | Fiscal-year operating modes | Reserved — NOT authorized, not applied | Not applied |
| 099 | Government payment details (G5) | **Applied (confirmed)** | UNKNOWN |
| 100 | Multi-document bank allocations (R9) | **Applied (confirmed)** | UNKNOWN |
| 101 | Custody controls (Q5) | **Applied (confirmed)** | UNKNOWN |
| 102 | Monthly close policy | **Applied (confirmed, column present)** | UNKNOWN |
| 103 | Counterparty labor relationship (G8) | **Applied (confirmed, column present)** | UNKNOWN |
Note: server start applies pending migrations; applying in any environment needs separate Owner approval.

## Deferred / Outstanding (preserved)
- Operating mode 3 (external accounting, mig 098): **DEFERRED**, not started, not authorized.
- Extended opening-balance reconciliation: **DEFERRED**.
- CoA import and unified import navigation: **DEFERRED** optional, not Phase C blockers.
- G6 zakat calculation from statements: **PARTIAL** (manual base only); needs Owner policy.
- G7 concurrency/versions: **PARTIAL**; full module inventory not done.
- R6 documents, R8 role dashboards, R7/R10 backup/restore and env separation, R11/R12 operational acceptance: **UNVERIFIED / not started**.
- #527 follow-ups: ledger-cutover lock order may deadlock with closeFiscalYear; no per-endpoint real-PG tests for all write paths.
- Literal-message error mappings (#514) keyed by English text; flaky `OpeningBalanceReview` and `Accounting.chart-edit-mode` tests; WHT mobile table; localization cleanup (needs Owner approval).

## Pending UAT Checklist (functional, not performed)
1. G1/G2 personal payment → approval → bank reimbursement → zero balance.
2. G3 statement ending balance vs ledger; monthly/annual close integration.
3. G5 government reference + period on settlement.
4. R9 one bank transaction → several documents; remainder blocks close.
5. Q5 custody controls, document picker, closed-period error.
6. G8 labor-relationship set/clear/filter on counterparties; aging unaffected.
7. #528 policy required vs optional; annual close gates still run over the full year.
8. #527 write in closed FY rejected on documents, bank, VAT, assets, custody.
9. Phase B: header identity, display name, role switch; company isolation.
10. Phase C: opening balances, cutover, historical records at the same SHA.

## Open Blockers
- None confirmed in code. Owner decisions pending: UAT scope/SHA, rollout of migrations 089–095 status, zakat policy, mode 3 (098).

## Next Exact Step
- Owner reviews this docs PR, then chooses: run the UAT checklist on Replit TEST at main, or start a remaining item.

---
*Keep under 100 lines.*
