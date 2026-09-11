# إقفال | EQFAL
# Current Operational Backlog

## Authority

`TODO.md` is the current operational backlog, not the highest project authority.

Authority hierarchy:

`GitHub/main → AGENTS.md → docs/WORKFLOW_GOVERNANCE.md → docs/TOOLING_RECOVERY_PLAYBOOK.md → docs/EXECUTION_ROADMAP.md → TODO.md → Historical records`

If this file conflicts with a higher source, the higher source governs. Historical material must never override current authoritative state.

## Reconciliation Metadata

Last reconciled against GitHub/main SHA:
`2644c9fde0062221240409d47795ae2ee0d022e3`

Reconciliation date:
`2026-09-11`

This SHA is an audit/reconciliation baseline only, not a promise that it remains future `main` HEAD.

---

# CURRENT STATE

## Current product status

- Phase 1 — Company Accounting & Tax Profile: **DONE**
- Phase 2 — Fixed Asset Depreciation Policy: **PARTIAL**
- Phase 3 — Opening Balance Review: **DONE**
- Phase 4 — Accruals / Prepayments / Periodic Adjustments: **DONE**
- Phase 5 — Financial Statement Mapping: **NOT STARTED**
- Phase 6 — VAT Reconciliation Hardening: **DONE FOR CURRENTLY APPROVED SCOPE**
- Phase 7 — Zakat / Income Tax / Withholding Tax: **PARTIAL**
- Phase 8 — Integrated Monthly Close: **PARTIAL / STRONG FOUNDATION**
- Phase 9 — Final Permission Model: **PARTIAL**
- Phase 10 — Company Manager Workspace: **PARTIAL**
- Phase 11 — Home Screen Alerts: **PARTIAL**
- Phase 12 — Manager Financial Snapshot: **NOT STARTED**
- Phase 13 — Conditional Modules: **DEFERRED**
- Phase 14 — Full Operational & Accounting Cycle Validation: **NOT STARTED**
- Phase 15 — System-wide UI/UX Redesign: **DEFERRED**

Notes:
- VAT is DONE only for the currently approved scope; future tax scope is neither implied nor pre-approved.
- Monthly Close remains PARTIAL until a dedicated completeness gap audit is accepted against the latest roadmap.
- Annual Closing readiness does not itself constitute final financial statements, zakat filing/calculation, or final year-end package export.

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

1. Build/test **Orchestrator**.
2. Build/test **Builder Role with Cloud Codex as primary execution engine**.
3. Build/test **Independent Reviewer**.
4. Run **Autonomous Agent PoC** with exact-SHA GitHub/CI evidence, independent review, merge-gate enforcement, recovery-path validation, and user-notification-state validation.
5. Resume Product roadmap from current dependencies only after Agent readiness is actually proven.

Do not claim Autonomous Agents are ready before this sequence is implemented and verified.

## Next real product gap

After Agent-readiness work, the currently identified next real Product gap is:

**Phase 5 — Chart Classification & Financial Statement Mapping**

Phase 8 Monthly Close remains PARTIAL pending its dedicated completeness gap audit. EQFAL Project must choose actual next Product work from current `main`, roadmap dependencies, and the approved governance at that time.

## Product backlog after Phase 5 dependency is addressed

- Complete remaining Fixed Asset depreciation-policy governance gaps.
- Continue Zakat / Income Tax / Withholding Tax workpapers/reconciliation according to approved future designs.
- Complete Final Permission Model.
- Complete Company Manager Workspace.
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
