# EQFAL Project State

**Last updated:** 2026-11-24
**Repository:** Sydiha/eqfal
**Branch:** main

## Current Baseline
- **Verified main HEAD at update time:** `60351fc` (merge of PR #611). GitHub `main` is the source of truth and may be ahead.
- **CI:** see GitHub checks on the commit (not restated here; not re-run in this docs task).
- Repo migrations: 001–097 and 099–137 present. **098 intentionally absent** (reserved, NOT authorized).
- Vocabulary: Implemented / Verified / Partial / Deferred / Pending UAT / Unknown. Code merged + CI green is NOT functional UAT.

## Phase Status
| Phase | Status |
|-------|--------|
| B Users/Permissions | Implemented (authorization policy #581, #603, #604); Pending UAT |
| C Company setup & financial import | Implemented in part (CoA import #544, cash opening balances #545–#547, #107–#111); Pending UAT; mode 3 and extended reconciliation Deferred |
| D Operational cycle | Implemented (G1–G3, G5, G8, R9, Q5, payroll, salary advances, bonuses); Pending UAT |
| E Reporting/Closing | Partial (Zakat engine and approval flow #594–#602; calculation still gated; G7 concurrency partial) |
| F Final readiness | Not started |

## Delivered Since #529 (merged; implementation + CI only, not UAT)
- **Docs/governance:** #530 docs sync; #555 Phase 14 evidence; #569/#571 Codex model routing policy; #603 authorization policy documentation.
- **Document integrity:** #531 draft overwrite guard (documents, journals, assets); #532/#534 R6 reopen and lifecycle; #533 R8 Action Center.
- **Banking:** #539/#540 manual bank transaction entry (mig 106); #542 obligation settlements in bank details; #578 bank ownership staging (mig 119, inert); #587 bounded historical bank ledger links.
- **Accounting:** #541 prefilled settlement drafts; #553 exact-cent reporting and settlements; #554 annual receivables/payables cutoff; #535 cutover lock order and closed-year codes; #585 monthly periods protected after FY close; #608 fiscal-year context.
- **Opening balances / cash:** #545–#547 cash on hand (mig 107–108); #109–#111 physical cash verification (mig 109–111).
- **Employee Cost Center:** #564–#568 foundation, bank reconciliation of employee costs, corrections; mig 112.
- **Payroll:** #570–#577 monthly drafts, allowance breakdown, approval, accounting readiness, safe posting, liability settlement (mig 114–120); #582 settlement segregation of duties (mig 123); #584/#586 closed-period blocks and safety confirmations.
- **Salary advances:** #588–#592 foundation and recovery through payroll (mig 124–126).
- **Financial authority:** #580 bounded delegation; #581 staged authorization policy (mig 122); #590/#592 separation of privileged actors (mig 127); #604 owner-approved policy enforced.
- **Zakat (G6):** #594 isolated engine; #595/#596 read-only preview; #598/#599 regulatory evidence and trusted approvals (mig 128); #601 approval integrity (mig 129); #602 safe revisions (mig 130). Calculation remains gated; see Open Blockers.
- **Bonuses (#609–#611):** entitlements, recognition, balances, direct settlement, adjustments, payment schedules, award identity (mig 131–137). Payroll take-home pay preserved; recognized amounts move into payroll payable; partial refunds restore balance; repeat bank use blocked. Owner acceptance on the same SHA was requested in PR #609 (outcome not recorded here).
- **Navigation/UI:** #560/#561 global page search and deep navigation; #548/#606/#607 responsive banking, trial balance and annual closing; #556–#558, #563 localization and display dates; #605 Arabic filename direction.

## Migration Status (089–137)
Migrations 096, 097, 099–103 were recorded in `_schema_migrations` on Replit TEST (owner confirmed 2026-10-30). Everything else: **UNKNOWN** unless noted. Server start applies pending migrations, so applying in any environment needs separate Owner approval.

| Mig | Feature | Replit TEST | Other envs |
|-----|---------|-------------|------------|
| 088 | Bank statement reconciliation (G3) | Applied (2026-10-18) | UNKNOWN |
| 089–095 | Personal payments, accounting profile, cutover supplements, invoice numbering/void, invoice mappings, user display_name | UNKNOWN | UNKNOWN |
| 096–097 | Historical records; opening-balance evidence exceptions | Applied (confirmed) | UNKNOWN |
| 098 | Fiscal-year operating modes | Reserved, NOT authorized, not applied | Not applied |
| 099–103 | G5 government details; R9 multi-allocation; Q5 custody; monthly close policy; G8 labor relationship | Applied (confirmed) | UNKNOWN |
| 104–137 | Draft revisions, Zakat worksheets/approvals, manual bank tx, cash and cash verification, employee cost center, payroll, bank ownership, authorization policy, salary advances, bonuses | UNKNOWN (files present in repo) | UNKNOWN |

## Deferred / Outstanding (preserved)
- Operating mode 3 (external accounting, mig 098): **DEFERRED**, not authorized.
- Extended opening-balance reconciliation: **DEFERRED**.
- CoA import as unified import navigation: **DEFERRED** optional.
- G6 zakat calculation: **PARTIAL**; calculation blocked until accountant decisions on gates B0/B3/B4/B7/B9 (`payable_amount` is null).
- G7 concurrency/versions: **PARTIAL**; full module inventory not done.
- R6 documents (partly delivered), R7/R10 backup/restore and env separation, R11/R12 operational acceptance: **UNVERIFIED / not started**.
- Bank ownership (#578, mig 119) is staging only; activation not authorized.
- Known follow-ups: ledger-cutover lock order (#527 note; partly addressed by #535, re-verify); no per-endpoint real-PG tests for all write paths; literal-message error mappings keyed by English text; flaky tests `OpeningBalanceReview` and `Accounting.chart-edit-mode`; WHT mobile table; localization cleanup.

## Pending UAT Checklist (functional, not performed)
1. G1/G2 personal payment → approval → bank reimbursement → zero balance.
2. G3 statement ending balance vs ledger; monthly/annual close integration.
3. G5 government reference + period on settlement.
4. R9 one bank transaction → several documents; remainder blocks close.
5. Q5 custody controls, document picker, closed-period error.
6. G8 labor-relationship set/clear/filter; aging unaffected.
7. #528 monthly policy required vs optional; annual close gates still run over the full year.
8. #527 closed-FY writes rejected on documents, bank, VAT, assets, custody.
9. Phase B: header identity, display name, role switch; company isolation; authorization policy (#604).
10. Phase C: opening balances, cash verification, cutover, historical records.
11. Payroll: draft → approval → posting → settlement, incl. closed-period block (#570–#586).
12. Salary advances: advance → payroll recovery (#588–#592).
13. Employee cost center: cost → approval → bank reconciliation → correction (#564–#568).
14. Bonuses (#609–#611): same-SHA owner acceptance as written in PR #609.
15. Zakat preview and approval flow (#594–#602), without calculation.

## Open Blockers
- No confirmed code blocker in this document.
- Owner decisions pending: UAT scope and SHA; migration rollout status for 089–137 on each environment; Zakat policy and accountant gate sign-off; mode 3 (098).

## Next Exact Step
- Owner reviews this docs PR. Then choose: UAT on Replit TEST at one SHA (payroll and bonuses first), or the Figma design phase (10 primary navigation pages without dedicated designs, per the owner-provided count; list to be confirmed).

---
*Keep under 100 lines.*
