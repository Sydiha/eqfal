# إقفال | EQFAL
# Current Operational Backlog

## Authority

`TODO.md` is the current operational backlog, not the highest project authority.

Authority hierarchy:

`GitHub/main → AGENTS.md → docs/WORKFLOW_GOVERNANCE.md → docs/TOOLING_RECOVERY_PLAYBOOK.md → docs/EXECUTION_ROADMAP.md → TODO.md → Historical records`

If this file conflicts with a higher source, the higher source governs. Historical material must never override current authoritative state.

## Reconciliation Metadata

Last reconciled against GitHub/main SHA:
`ff7fa41b544037a30b5cc00ac3869e22d400526b`

Reconciliation date:
`2026-09-18`

This SHA is an audit/reconciliation baseline only, not a promise that it remains future `main` HEAD.

---

# CURRENT STATE

## Current product status

- Phase 1 — Company Accounting & Tax Profile: **DONE**
- Phase 2 — Fixed Asset Depreciation Policy: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 3 — Opening Balance Review: **DONE**
- Phase 4 — Accruals / Prepayments / Periodic Adjustments: **DONE**
- Phase 5 — Financial Statement Mapping: **DONE**
- Phase 6 — VAT Reconciliation Hardening: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 7 — Zakat / Income Tax / Withholding Tax: **PARTIAL**
- Phase 8 — Integrated Monthly Close: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 9 — Final Permission Model: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 10 — Company Manager Workspace: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 11 — Home Screen Alerts: **PARTIAL**
- Phase 12 — Manager Financial Snapshot: **NOT STARTED**
- Phase 13 — Conditional Modules: **DEFERRED**
- Phase 14 — Full Operational & Accounting Cycle Validation: **NOT STARTED**
- Phase 15 — System-wide UI/UX Redesign: **DEFERRED**

Notes:
- Phase 2 closure was read-only reconciled against GitHub/main SHA `14c9bc025193a74bc4a4ea7055d15a5a40fedea9`; governed depreciation-policy lifecycle, effective dating/history, prospective active-asset estimate changes, policy-exception handling, and the operational workflow surface are implemented for the currently approved scope.
- Advanced fixed-asset topics including impairment, revaluation, components, multiple books, tax depreciation, active-asset depreciation-method changes, retrospective restatement, and advanced proration remain deferred unless a future Read-only Design Check proves they are required.
- VAT is DONE only for the currently approved scope; future tax scope is neither implied nor pre-approved.
- Phase 8 Monthly Close closure was read-only reconciled against GitHub/main SHA `5766d58154fce89f6908a056bf9f62cf6e105537`; blocker coverage, company-aware applicability, capability-aware disclosure, drill-through, close enforcement, and reopen reason/audit/capability behavior are implemented for the currently approved scope.
- Phase 9 Final Permission Model closure was read-only reconciled against GitHub/main SHA `116dc676772b20220e7b77704bafe9f1a0d3c243`; reviewed runtime authorization is granular for the approved scope, Access Administration is split into action-specific capabilities, legacy `access.manage` is no longer a runtime fallback, and Grant Ceiling / Full Access / self-escalation / tenant isolation / audit protections remain enforced.
- Phase 10 Company Manager Workspace closure was read-only reconciled against GitHub/main SHA `ff7fa41b544037a30b5cc00ac3869e22d400526b`; manager-facing navigation, daily operational entry, capability-aware visibility, and the separation of operational entry from accounting approval mechanics are complete for the currently approved scope.
- Annual Closing readiness does not itself constitute final financial statements, zakat filing/calculation, or final year-end package export.
- Phase 5 was read-only reconciled against GitHub/main SHA `212d6b94b40a8d0c8bcb1ee7d0c16380e8e360ca`; the approved chart-classification and financial-statement mapping scope is implemented and tested, so it is no longer a Product gap.

## Governance / Agent-readiness status

- Previous Governance Reconciliation: **DONE**.
- Replit Sync PoC: **PASS WITH HUMAN ACTION**.
  - verified PoC SHA: `2644c9fde0062221240409d47795ae2ee0d022e3`;
  - Preview startup: **PASS**;
  - full autonomous GitHub → Replit sync: **NOT YET PROVEN**;
  - runtime SHA verification from the running application: **NOT YET PROVEN**.
- Autonomous Operating Model governance package: **CURRENT GOVERNANCE WORK** until merged.
- Orchestrator: **NOT YET BUILT/PROVEN**.
- Builder Role + Cloud Codex integration: **NOT YET BUILT/PROVEN**.
- Independent Reviewer: **NOT YET BUILT/PROVEN**.
- Autonomous Agent PoC: **NOT YET RUN/PROVEN**.

## Active architecture sequence after governance merge

Two independent tracks are active:

### Product Track

1. Resume Product roadmap from current dependencies/current `main` without waiting for Full Autonomous Readiness.
2. Phase 2, Phase 5, Phase 8, and Phase 9 are complete for their currently approved scopes and must not be recreated as Product gaps unless a new Read-only Design Check identifies a real deficiency.
3. Select the next Product task from the remaining **PARTIAL / NOT STARTED** roadmap items using current dependencies and a dedicated Read-only Design Check.
4. Continue normal Product governance: Read-only Design Check → Execution Contract → Builder → durable GitHub delivery → Independent Reviewer → exact-SHA CI → Merge Gate → merge → Replit/runtime validation.

### Agent Infrastructure Track

1. Continue solving the **Automatic Continuation Gap** independently.
2. This gap blocks **Full Autonomous Readiness only** and does not block Product work.
3. Do not claim Full Autonomous Readiness until event-driven continuation is operationally proven.

## Parallel repository hygiene / review backlog

These existing items remain open unless separately verified complete; they do not change Product phase status or authorize automatic destructive actions:

- Review open PR #140 and PR #96 separately; do not merge or close them solely from this backlog.
- Run a read-only stale-branch hygiene audit before any branch deletion.
- Any branch deletion, force/history rewrite, or other destructive/exceptional Git recovery must follow current governance and applicable Human Gates.

## Next real product gap

Phase 2, Phase 5, Phase 8, and Phase 9 are no longer Product gaps for their currently approved scopes.

The next Product task must be chosen from the remaining **PARTIAL / NOT STARTED** roadmap items based on current `main`, dependencies, and a dedicated Read-only Design Check before implementation.

EQFAL Project must choose actual next Product work from the remaining PARTIAL / NOT STARTED roadmap items using current `main`, roadmap dependencies, and the approved governance at that time.

## Remaining product backlog after Phase 2 closure

- Continue Zakat / Income Tax / Withholding Tax workpapers/reconciliation according to approved future designs.
- Complete Home Screen Alerts.
- Build Manager Financial Snapshot only from trustworthy accounting data.
- Execute Full Operational & Accounting Cycle Validation.
- Perform System-wide UI/UX Redesign only after functional/accounting completion and full-cycle validation.

## Conditional / deferred work

Remain deferred unless justified and passed through applicable Design/Human Gates:
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
- Internal Design Approval is allowed only under the conditions in `AGENTS.md` / `docs/WORKFLOW_GOVERNANCE.md` after that governance is merged.
- Builder cannot self-review or self-merge.
- Independent Reviewer and required exact-SHA CI are mandatory for normal merge.
- Production, new paid cost, destructive real-data actions, material accounting/tax policy changes, secrets/credentials, specified sensitive real-user access changes, material unresolved ambiguity, and exceptional Git recovery remain Human Gates.
- Replit is runtime/practical validation only and may not write to GitHub.
- Replit Agent is FREE MODE ONLY within the approved allowlist; if Free Mode is no longer actually free: STOP.
- Tooling incidents follow `docs/TOOLING_RECOVERY_PLAYBOOK.md`.

---

# HISTORICAL RECORD

**Historical only — do not use this section for current task selection, current phase status, current HEAD, or governance authority.**

The prior backlog described earlier project stages and the pre-autonomous workflow. Those records remain useful as project history, but current GitHub/main implementation and the authority hierarchy supersede their use as current status.

For durable historical decisions and rationale, consult `DECISIONS.md` and merged GitHub PR/commit history.
