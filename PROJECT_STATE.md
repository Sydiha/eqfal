# EQFAL Project State

**Last updated:** 2026-10-27
**Repository:** Sydiha/eqfal
**Branch:** main

## Current Baseline
- **Verified main HEAD at update time:** `3bab615b6380649274460990ca054e371fb0e805` (PR #505, C4-UI1). GitHub `main` is the source of truth and may be ahead.
- **CI:** see GitHub checks on the commit (not restated here; not re-run in this docs task).
- **Open PRs at update time:** #464 (docs, T1 UAT note; untouched) + the C6 docs PR.
- Repo migrations: 001–097 present. Application status per environment is NOT verified here (see Migrations).

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
- Optional chart-of-accounts import and unified import navigation: owner requirement recorded; **no implementation found in main (search of client/server)**.
- Monthly closing policy: owner intends monthly close to be **optional**; the required `monthly_close_policy` implementation is **PENDING** (today monthly close remains required for annual close).

**Not verified:** same-SHA operational acceptance tests (Replit TEST/UAT at `3bab615`) were not performed or evidenced. Phase C is therefore NOT marked fully verified.

## Migrations (what is known)
- 088 applied to Replit TEST only (memory, 2026-10-18). 089–097 application status on TEST/Staging/Production: **not verified**. Server applies pending migrations at start-up, so pulling main into an environment applies them; needs separate Owner approval.

## Phase 14 / Invoice notes (older, unchanged)
- Phase 14 per-row status: `docs/PHASE_14_FULL_CYCLE_VALIDATION_MATRIX.md` §9; T7 evidence `docs/evidence/t7/`.
- Invoice VAT V1/V2/V2.1 and adjustments V3.x are merged; operational activation and migration rollout are Owner decisions, not verified here.

## Current Task
- **C6** docs-only: Phase C handoff + Phase D gap identification (this PR). No code.

## Open Blockers
- None confirmed.

## Next Exact Step
- Owner reviews the C6 docs PR, then decides: same-SHA TEST/UAT for Phase C, and whether to start the recommended Phase D task (roadmap §14).

---
*Keep under 100 lines.*
