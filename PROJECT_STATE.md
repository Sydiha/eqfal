# EQFAL Project State

**Last updated:** 2026-10-29
**Repository:** Sydiha/eqfal
**Branch:** main

## Current Baseline
- **Verified main HEAD at update time:** `4564c8b` (PR #519, PR-4B). GitHub `main` is the source of truth and may be ahead.
- **CI:** see GitHub checks on the commit (not restated here; not re-run in this docs task).
- **Open PRs at update time:** #464 (docs, T1 UAT note; untouched) + this docs-sync PR.
- Repo migrations: 001–097 and 099–101 present (098 intentionally absent; reserved, NOT authorized). Application status per environment is NOT verified here (see Migrations).

## Phase Status (vocabulary: Implemented / Verified / Partial / Deferred / Not verified)
| Phase | Status |
|-------|--------|
| B Users/Permissions | Implemented — not verified (no UAT) |
| C Company setup & financial import | **Implemented in part; NOT fully verified; some items Deferred** (details below) |
| D Operational cycle | Partial — see `docs/EQFAL_MASTER_ROADMAP.md` §14 gap matrix |
| E Reporting/Closing | Partial |
| F Final readiness | Not started |

## Phase C Record (as of 3bab615)
**Implemented (merged; code + CI tests only unless stated):**
- Source Authority + mid-year Cutover (083–086, 091), full-year statements, supplements (S1/S2, #476/#477).
- Opening balances: T1 partner attribution (#463, owner UAT on TEST passed per memory), T7.1–T7.4 import (#484–#485), retained-earnings carry-forward (P1 #494), closed-year classification lock (P2 #495), annual package V2 fingerprint (P3 #496).
- Historical records (C5-P2..P5, #498–#501; migration 096): internal records, no ledger link.
- Opening-balance integrity & reconciliation gate (C4-P2a #502), evidence exceptions (C4-P2b-1 migration 097 #503, UI #504), opening-balances UX redesign (C4-UI1 #505: 3 tabs, no migration).
- Phase B finalization (#497, migration 095 display_name).

**Approved fiscal-year operating modes (owner-approved definitions; per fiscal year):**
1. Native / new company: EQFAL ledger is the source of truth (opening balance path).
2. Migrated / cutover from external system: external reference before cutover date D, EQFAL ledger after D (Source Authority).
3. External accounting (continuing): external system is the source; EQFAL holds approved TB copies only; no EQFAL journals in that year.
- Today only modes 1 and 2 exist, implicitly (no mode declaration in code). Mode 3 is **DEFERRED — implementation not started**.
- **Migration 098 (`fiscal_year_operating_modes`) is NOT authorized and NOT implemented.** Designs: `/mnt/project-files/audits/c5-p1…p4-2026-10-27/` (not in repo).
- Extended opening-balance reconciliation: **DEFERRED**.
- Chart-of-accounts import and unified import navigation: **DEFERRED optional enhancements**, not Phase C completion blockers. No implementation found in main (search of client/server).
- Monthly closing policy: owner intends monthly close to be **optional in all three operating modes**; **NOT implemented** (PENDING). It must not weaken annual financial readiness requirements (annual close gates must still run over the full year).

**Not verified:** same-SHA operational acceptance tests (Replit TEST/UAT at `3bab615`) were not performed or evidenced. Phase C is therefore NOT marked fully verified.

## Work Delivered After Phase C (#506–#519, all merged to main)
Implementation + CI only. No Production/Staging deployment was performed as part of this PR workflow; no operational verification at these SHAs.
- #506 docs C6 Phase C handoff + Phase D gap matrix.
- #507 D1/G5: optional government payment reference + period on obligation settlements (migration 099, additive).
- #508 D2/R9: one bank transaction settling several documents (migration 100).
- #509 D4/Q5: custody ledger-account controls, actual recipient, funding unlink (migration 101).
- #510 R9 allocation candidates use real document remaining amount; fully settled documents hidden. #512 SettlementPanel refreshes after create/remove.
- #511 CI: PostgreSQL client tools pinned to 16 (matches postgres:16 service).
- #513 PR-2A actionable AR/EN error messages in five financial screens (UI only).
- #514 PR-2B stable `code` on confirmed 409s (settlements, bank, opening balances, annual package; `requireAll` 403 `FORBIDDEN`). No migration.
- #515 PR-3A, #516 PR-3B, #517 PR-3C, #518 PR-4A, #519 PR-4B: RTL/mobile/localization UI fixes (SettlementPanel cards, AnnualClosing tabs/dates, Obligations cards, banking tabs, WHT Arabic terms, LTR filenames; Add Item form state and missing bank currency guard). Frontend only.

## Known Remaining Issues (not fixed)
- **Flaky test:** `OpeningBalanceReview.test.tsx > calls the approve endpoint only when balanced` failed once in CI on an unrelated commit, passed on re-run; cause not established. `Accounting.chart-edit-mode` also reported flaky. Investigate as a real timing issue if it recurs.
- **Literal-message error mappings:** server error codes in #514 (`banking-error-codes.ts`, `OB_CONFLICT_CODES`, `ANNUAL_PACKAGE_CONFLICT_CODES`) are keyed by exact English message text; changing a message silently drops its code. Uncovered: obligation version/create/update conflicts, custody, bank import, "match is invalid"/"no longer valid", JournalPosting.
- **WHT mobile table:** owner reports a remaining mobile table issue on WHT; not re-verified in this docs task. Earlier items: WHT raw English values in Arabic UI, classification panel bilingual line in locked CSS.
- **Deferred localization architecture cleanup:** not started; needs separate Owner approval.
- **Readiness gaps (from record):** see Migrations and Phase Status; same-SHA TEST/UAT not evidenced for Phase C or #506–#519.

## Completed Implementation vs Production Verification
- Completed = merged to main with CI (verify, Vercel preview) green.
- NOT verified: Replit TEST/UAT at current SHA; migrations 099–101 not applied to any shared environment per record; Production and Staging not deployed.

## Migrations (what is known)
- 088 applied to Replit TEST only (memory, 2026-10-18). 089–097 and 099–101 application status on TEST/Staging/Production: **not verified**. Server applies pending migrations at start-up, so pulling main into an environment applies them; needs separate Owner approval.

## Phase 14 / Invoice notes (older, unchanged)
- Phase 14 per-row status: `docs/PHASE_14_FULL_CYCLE_VALIDATION_MATRIX.md` §9; T7 evidence `docs/evidence/t7/`.
- Invoice VAT V1/V2/V2.1 and adjustments V3.x are merged; operational activation and migration rollout are Owner decisions, not verified here.

## Current Task
- Docs-only sync of state files through #519 (this PR). No code.

## Open Blockers
- None confirmed.

## Next Exact Step
- Owner reviews this docs PR, then decides: same-SHA TEST/UAT for Phase C, and whether to start the recommended Phase D task (roadmap §14).

---
*Keep under 100 lines.*
