# إقفال | EQFAL
# Current Operational Backlog

## Authority

`TODO.md` is the current operational backlog, not the highest project authority.

Authority hierarchy:

`GitHub/main → AGENTS.md → docs/WORKFLOW_GOVERNANCE.md → docs/TOOLING_RECOVERY_PLAYBOOK.md → docs/EXECUTION_ROADMAP.md → TODO.md → Historical records`

If this file conflicts with a higher source, the higher source governs. Historical material must never override current authoritative state.

## Reconciliation Metadata

Reference SHA at time of reconciliation (Phases 1–12) — not current HEAD:
`14846d39f85e2718677071705e762bc1dd21e789`

Reconciliation date:
`2026-09-20`

Phase 13–15 status and the governance sections were updated on `2026-10-03`; reference SHA at that time (not current HEAD): `181f37ed60920cdf406155049173a9924272c0bb`. Phase 14–15 wording was re-reconciled on `2026-10-06` against `468cfac20d8a01f567dd4104d5d4669ecc78d345` (also an audit reference, not current HEAD).

These SHAs are audit/reconciliation references only, not promises that either remains future `main` HEAD.

---

# CURRENT STATE

## Current product status

- Phase 1 — Company Accounting & Tax Profile: **DONE**
- Phase 2 — Fixed Asset Depreciation Policy: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 3 — Opening Balance Review: **DONE**
- Phase 4 — Accruals / Prepayments / Periodic Adjustments: **DONE**
- Phase 5 — Financial Statement Mapping: **DONE**
- Phase 6 — VAT Reconciliation Hardening: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 7 — Zakat / Income Tax / Withholding Tax: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 8 — Integrated Monthly Close: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 9 — Final Permission Model: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 10 — Company Manager Workspace: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 11 — Home Screen Alerts: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 12 — Manager Financial Snapshot: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 13 — Conditional Modules: **CONDITIONAL / DEFERRED**
- Phase 14 — Full Operational & Accounting Cycle Validation: **IN PROGRESS / PARTIALLY VALIDATED** (14A merged; 14B PARTIAL (row 5 PASS, rows 1–4 PARTIAL); other rows hold PARTIAL or NOT RUN status — per-row source of truth is matrix §9 in `docs/PHASE_14_FULL_CYCLE_VALIDATION_MATRIX.md`; see also `docs/EXECUTION_ROADMAP.md`)
- Phase 15 — System-wide UI/UX Redesign: **PARTIALLY MERGED / IN PROGRESS**

Notes:
- Phase 2 closure was read-only reconciled against GitHub/main SHA `14c9bc025193a74bc4a4ea7055d15a5a40fedea9`; governed depreciation-policy lifecycle, effective dating/history, prospective active-asset estimate changes, policy-exception handling, and the operational workflow surface are implemented for the currently approved scope.
- Advanced fixed-asset topics including impairment, revaluation, components, multiple books, tax depreciation, active-asset depreciation-method changes, retrospective restatement, and advanced proration remain deferred unless a future Read-only Design Check proves they are required.
- VAT is DONE only for the currently approved scope; future tax scope is neither implied nor pre-approved.
- Phase 8 Monthly Close closure was read-only reconciled against GitHub/main SHA `5766d58154fce89f6908a056bf9f62cf6e105537`; blocker coverage, company-aware applicability, capability-aware disclosure, drill-through, close enforcement, and reopen reason/audit/capability behavior are implemented for the currently approved scope.
- Phase 9 Final Permission Model closure was read-only reconciled against GitHub/main SHA `116dc676772b20220e7b77704bafe9f1a0d3c243`; reviewed runtime authorization is granular for the approved scope, Access Administration is split into action-specific capabilities, legacy `access.manage` is no longer a runtime fallback, and Grant Ceiling / Full Access / self-escalation / tenant isolation / audit protections remain enforced.
- Phase 10 Company Manager Workspace closure was read-only reconciled against GitHub/main SHA `ff7fa41b544037a30b5cc00ac3869e22d400526b`; manager-facing navigation, daily operational entry, capability-aware visibility, and the separation of operational entry from accounting approval mechanics are complete for the currently approved scope.
- Phase 7 closure was reconciled against GitHub/main SHA `14846d39f85e2718677071705e762bc1dd21e789`; PRs #211, #213, #272, and #274 provide governed tax/Zakat workpapers, Annual Closing Packages, WHT review, and professional review/approval. Company profile fields `tax_treatment`, `ownership_context`, `wht_profile`, and `has_non_resident_dealings` provide the approved applicability context.
- Phase 11 closure was reconciled against the same baseline; Home Alerts provide capability-aware, backend-authoritative ownership classification, module visibility boundaries, preserved drill-through, and capability-safe Monthly Close readiness/blocker disclosure.
- Phase 12 closure was reconciled against the same baseline; the Phase 12A operational snapshot provides trusted available running bank balances, receivables, payables, current-month approved sales and purchases/expenses, plus explicit capability-aware hidden/unavailable states.
- Annual Closing readiness does not itself constitute final financial statements, tax filing/calculation, automatic WHT rate/treaty/liability determination, or replacement of professional tax judgment. The manager snapshot is not a profitability statement and adds no profit, margin, EBITDA, forecasting, or AI scope.
- Phase 5 was read-only reconciled against GitHub/main SHA `212d6b94b40a8d0c8bcb1ee7d0c16380e8e360ca`; the approved chart-classification and financial-statement mapping scope is implemented and tested, so it is no longer a Product gap.

## Governance status

Current governance is defined by `AGENTS.md` (owner-controlled; no autonomous or multi-agent workflow; no automatic merge).

- Previous Governance Reconciliation: **DONE**.
- Replit Sync PoC: **PASS WITH HUMAN ACTION**.
  - verified PoC SHA (historical): `2644c9fde0062221240409d47795ae2ee0d022e3`;
  - Preview startup: **PASS**;
  - full autonomous GitHub → Replit sync: **NOT YET PROVEN**;
  - runtime SHA verification from the running application: **NOT YET PROVEN**.
- Autonomous Operating Model (Orchestrator / Builder Role / Independent Reviewer / Autonomous Agent PoC / Automatic Merge Gate): **SUPERSEDED — current governance is defined by AGENTS.md**. History is kept in `DECISIONS.md`; none of it is an active instruction.

## Active architecture sequence

Governance is defined by `AGENTS.md`. The previous two-track (Product / Agent Infrastructure) model is **SUPERSEDED — current governance is defined by AGENTS.md**.

### Product Track

1. Resume Product roadmap from current dependencies/current `main`.
2. Phase 2, Phase 5, Phase 7, Phase 8, Phase 9, Phase 10, Phase 11, and Phase 12 are complete for their currently approved scopes and must not be recreated as Product gaps unless a new Read-only Design Check identifies a real deficiency.
3. Phase 14 is IN PROGRESS / PARTIALLY VALIDATED and Phase 15 is PARTIALLY MERGED / IN PROGRESS; see `docs/EXECUTION_ROADMAP.md`.
4. Every Product task follows the `AGENTS.md` workflow: READ-ONLY → PLAN → OWNER APPROVAL → CODEX PREFLIGHT → CODEX EXECUTION → EQFAL REVIEW → TESTS / CI → GITHUB HANDOFF → REPLIT SAME-SHA VALIDATION → OWNER UAT → OWNER MERGE DECISION.

## Parallel repository hygiene / review backlog

These existing items remain open unless separately verified complete; they do not change Product phase status or authorize automatic destructive actions:

- PR #140 and PR #96 are already closed without merge (closed 2026-09-11); no action needed from this backlog.
- Reconcile stale GitHub Issues (read-only review first; do not close in bulk without Owner Approval).
- Run a read-only stale-branch hygiene audit before any branch deletion.
- Any branch deletion, force/history rewrite, or other destructive/exceptional Git recovery must follow current governance (`AGENTS.md`) and explicit Owner Approval.

## Next real product gap

Phase 2, Phase 5, Phase 7, Phase 8, Phase 9, Phase 10, Phase 11, and Phase 12 are no longer Product gaps for their currently approved scopes.

Phase 14 — Full Operational & Accounting Cycle Validation is **IN PROGRESS / PARTIALLY VALIDATED**: 14A (validation matrix) is merged and 14B (Steps 1–5) is PARTIAL (Issue #286; row 5 PASS); other rows hold PARTIAL status, some from owner-supplied external evidence that is not repository evidence; row 11 remains NOT RUN; per-row status in matrix §9; further slices follow `docs/PHASE_14_FULL_CYCLE_VALIDATION_MATRIX.md` §8. Each slice requires its own governed plan and Owner Approval.

## Remaining product backlog

- Complete the remaining Phase 14 validation evidence (rows NOT RUN or PARTIAL) per `docs/PHASE_14_FULL_CYCLE_VALIDATION_MATRIX.md`.
- Keep Phase 13 conditional modules deferred unless a genuine company need is established and Owner Approval is given.
- Phase 15 System-wide UI/UX Redesign is PARTIALLY MERGED / IN PROGRESS (recent UX packs through Task 31 are merged; no residual item list is recorded — Owner confirms whether any scope remains). See `docs/EXECUTION_ROADMAP.md`.

## Conditional / deferred work

Remain deferred unless justified and Owner Approval is given:
- Inventory / COGS for companies that genuinely require it.
- E-invoicing / ZATCA Fatoora.
- Paid OCR/AI/messaging/external integrations.
- Automatic/scored bank matching.
- Many-to-many bank transaction allocation.
- Advanced funding/prepayment patterns beyond approved foundations.
- Production deployment.

## Permanent operational safeguards

- GitHub/main is the sole merged source of truth.
- One bounded programming task at a time.
- Every Product task begins with Read-only Design Check.
- Owner Approval is required before coding; internal/automatic design approval is not permitted (see `AGENTS.md`).
- The coding engine (Codex Cloud) cannot self-review or self-merge; only the Owner makes the merge decision. No automatic merge.
- Required exact-SHA CI must pass, but CI alone never authorizes a merge (see `AGENTS.md` §13).
- Production, new paid cost, destructive real-data actions, material accounting/tax policy changes, secrets/credentials, specified sensitive real-user access changes, material unresolved ambiguity, and exceptional Git recovery require explicit Owner Approval.
- Replit is runtime/practical validation only and may not write to GitHub.
- Replit Agent is prohibited in all circumstances; only manual Replit Shell is permitted for approved Replit synchronization/runtime/validation commands.
- Tooling incidents follow `docs/TOOLING_RECOVERY_PLAYBOOK.md`.

---

# HISTORICAL RECORD

**Historical only — do not use this section for current task selection, current phase status, current HEAD, or governance authority.**

The prior backlog described earlier project stages and the pre-autonomous workflow. Those records remain useful as project history, but current GitHub/main implementation and the authority hierarchy supersede their use as current status.

For durable historical decisions and rationale, consult `DECISIONS.md` and merged GitHub PR/commit history.
