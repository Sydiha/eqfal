# إقفال | EQFAL
# Current Operational Backlog

## Authority

`TODO.md` is the current operational backlog, not the highest project authority.

Authority hierarchy:

`GitHub/main → AGENTS.md → docs/WORKFLOW_GOVERNANCE.md → docs/TOOLING_RECOVERY_PLAYBOOK.md → docs/EXECUTION_ROADMAP.md → TODO.md → Historical records`

If this file conflicts with a higher source, the higher source governs. Historical material must never be used to override current authoritative state.

## Reconciliation Metadata

Last reconciled against GitHub/main SHA:
`6b1b75382d9cedb9d2b2fb229aa3e9a860cbbc69`

Reconciliation date:
`2026-09-11`

This SHA is an audit/reconciliation baseline only. It is **not** a promise that it remains the current GitHub/main HEAD after later merges.

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
- VAT is DONE only for the currently approved scope; future tax work is neither implied nor pre-approved.
- Monthly Close has a strong foundation but remains PARTIAL until a dedicated completeness gap audit is performed against the latest roadmap.
- Annual Closing readiness foundation is present on `main`; it does not by itself constitute final financial statements, zakat calculation/filing, or final year-end package export.

## Active governance / Agent-readiness backlog

1. Complete and merge the Governance Reconciliation documentation PR.
2. Run a **Replit Sync Proof of Concept** using Replit Agent **FREE MODE ONLY** and only within the approved operational allowlist.
3. Confirm Replit Free Mode sync/run/smoke-test/runtime-SHA verification works without coding, GitHub writes, Power, Max, or paid credits.
4. Review open PR #140 and PR #96 separately; do not merge or close them automatically from this backlog.
5. Run a read-only stale-branch hygiene audit before any branch deletion.
6. Run a dedicated **Integrated Monthly Close Completeness Gap Audit** against the latest roadmap.
7. Re-run **Agent Readiness Audit** for the proposed Orchestrator / Builder / Reviewer architecture.

## Next real product gap

After the Agent-readiness/governance work above, the next real product gap is:

**Phase 5 — Chart Classification & Financial Statement Mapping**

No implementation starts until a dedicated Read-only Design Check is completed and approved.

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

Remain deferred unless separately approved and justified:
- Inventory / COGS for companies that genuinely require it.
- E-invoicing / ZATCA Fatoora.
- Paid OCR/AI/messaging/external integrations.
- Automatic/scored bank matching.
- Many-to-many bank transaction allocation.
- Advanced funding/prepayment patterns beyond the approved foundations.
- Production deployment.

## Permanent operational safeguards

- GitHub/main is the sole merged source of truth.
- One programming task at a time.
- Read-only Design Check before implementation.
- No Production without explicit approval.
- No new paid service, paid API, plan upgrade, or extra credits without explicit approval.
- Replit Agent is FREE MODE ONLY, limited to the approved operational allowlist and subject to successful Replit Sync PoC.
- If Free Mode is no longer actually free: STOP.
- Codex tooling incidents follow `docs/TOOLING_RECOVERY_PLAYBOOK.md`.

---

# HISTORICAL RECORD

**Historical only — do not use this section for current task selection, current phase status, current HEAD, or governance authority.**

The previous version of this file was last updated on `2026-08-17` and described the project when the main execution milestone was the completion of the banking/payment/custody Phase 3 era. It recorded, among other things:

- Core security / tenancy / auth / memberships / capabilities foundations as complete.
- Fiscal Years foundation as complete.
- Documents as closed.
- Banking import, matching/reconciliation, payment settlement, custody/advances, and real-bank-statement import validation as closed.
- Practical Phase 3 evidence including bank import, settlements, custody closeout, audit trail, company isolation, and permission tests.
- Older next-step suggestions around Banking UI/UX and early functional roadmap phases.
- Older deferred items such as automatic matching, many-to-many transaction allocation, advanced payment/funding patterns, VAT work, partners/obligations, monthly close, zakat, and later UI/UX.

Those records remain useful as project history, but later GitHub/main implementation superseded their use as current status. For durable historical decisions and rationale, consult `DECISIONS.md` and merged GitHub PR/commit history.
