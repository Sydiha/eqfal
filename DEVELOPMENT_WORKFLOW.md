# DEVELOPMENT_WORKFLOW

This file is the concise day-to-day development procedure for EQFAL. It is subordinate to `AGENTS.md` and `docs/WORKFLOW_GOVERNANCE.md`.

## Instruction precedence

1. `AGENTS.md`
2. `docs/WORKFLOW_GOVERNANCE.md`
3. `DEVELOPMENT_WORKFLOW.md`
4. Specialized operational playbooks

Historical / superseded documents are not current operating instructions.

If a material conflict exists: **STOP and report it to the Project Owner. Do not choose an interpretation independently.**

## Roles

### Project Owner
- explicit approval before Product Coding;
- final UAT;
- sole Merge Decision authority;
- explicit authority for Production or new paid cost.

Silence is not approval.

### EQFAL
EQFAL is the sole coordinator. It inspects, diagnoses, plans, prepares the Codex task, reviews output, verifies tests/CI/GitHub/Replit SHA integrity, and prepares Owner UAT.

### Codex Cloud
Codex Cloud is allowed only as a bounded Coding Engine after Owner Approval and successful Codex preflight.

**No autonomous or multi-agent workflow:** no Orchestrator Agent, Builder Agent, Reviewer Agent, autonomous continuation, unattended execution, automatic task selection, or automatic merge.

## Official task flow

`READ-ONLY → PLAN → OWNER APPROVAL → CODEX PREFLIGHT → CODEX EXECUTION → EQFAL REVIEW → TESTS / CI → GITHUB HANDOFF → REPLIT SAME-SHA VALIDATION → OWNER UAT → OWNER MERGE DECISION`

No gate may be skipped.

## 1. READ-ONLY

EQFAL reads current `GitHub/main`, records the baseline SHA, inspects the relevant implementation and constraints, and identifies likely files, gaps, tests, and risks.

No Product edit occurs.

## 2. PLAN

EQFAL prepares a bounded plan with:
- goal;
- baseline SHA;
- expected files/scope;
- out-of-scope/protected areas;
- tests/CI;
- risks;
- acceptance criteria;
- likely Codex Credit risk.

## 3. OWNER APPROVAL

Product Coding starts only after explicit approval of the plan by the Owner.

Any new Codex Cloud execution after the initial run requires renewed explicit Owner Approval before execution, including a bounded correction that stays inside the same scope. EQFAL may diagnose and prepare the correction plan without new approval, but there is no implicit approval and no automatic Codex correction loop.

## 4. CODEX PREFLIGHT

Verify before Coding:
- repository `Sydiha/eqfal`;
- correct base/branch;
- correct approved baseline HEAD SHA;
- required repository files readable;
- required execution/test environment usable.

If this fails: STOP. Do not use random Coding retries.

Create/Update PR capability is a later GitHub handoff concern and does not define Coding readiness.

## 5. CODEX EXECUTION

Send Codex one complete bounded implementation task including goal, baseline/SHA, scope/files, constraints, protected areas, required tests, and success criteria.

### Credit discipline
- Codex Credit must be conserved.
- EQFAL performs diagnosis/planning itself where possible.
- No unnecessary exploration in Codex.
- No repeat prompt without failure diagnosis.
- Every new Codex Cloud execution after the initial run requires new explicit Owner Approval, including bounded corrections inside the same scope.
- No rerun because push/PR/handoff failed.
- No unrelated refactor or dependency upgrade.
- Tell the Owner first if multiple Codex runs or high Credit use is reasonably expected.

## 6. EQFAL REVIEW

Review the actual diff/result against the approved plan. Check scope, protected boundaries, regressions, accounting/tax/tenancy/permissions/audit/schema concerns when applicable.

Do not accept Codex's own summary as proof.

## 7. TESTS / CI

Run the approved tests and applicable typecheck/lint/build. Verify CI on the intended exact SHA.

Do not proceed with a relevant P1 or related failing CI.

## 8. GITHUB HANDOFF

Preferred path:

`Codex result/commit → GitHub branch/commit → PR → CI`

Push/Create PR/Update PR failure is not a reason to rerun Coding.

Treat delivery failure separately, preserve valid work, and diagnose the handoff. Manual GitHub handoff does not require new Owner Approval when it only transports the same already-approved implementation without changing code or scope (such as branch creation, pushing the approved result, PR creation/update, or non-implementation PR metadata). If handoff requires code/implementation changes, a new Codex run, scope change, dependency addition, or behavior change, return to OWNER APPROVAL before Coding.

Never claim a PR exists or is updated until GitHub verifies it.

## 9. REPLIT SAME-SHA VALIDATION

Replit is Runtime / Practical Validation only.

Before Owner UAT, prove:

`GitHub PR HEAD SHA == Replit validated SHA`

When a Codex commit/result is identifiable, maintain traceability through the same delivery chain.

SHA mismatch or unprovable SHA = STOP.

## 10. OWNER UAT

EQFAL provides a practical checklist that tells the Owner:
- where to go;
- what to click;
- what to enter;
- what to inspect;
- expected result;
- important error/edge cases.

Owner performs final UAT.

## 11. OWNER MERGE DECISION

Only the Owner may decide to merge.

No automatic merge. No implicit approval. Silence is not approval. Coding approval is not merge approval.

## Permanent boundaries

- One task at a time.
- No autonomous or multi-agent workflow.
- `GitHub/main` is the Source of Truth.
- No Production changes without explicit Owner Approval.
- No new paid service/API/credits/infrastructure/plan without explicit Owner Approval.
- No scope expansion or unrelated refactor.
- No dependency upgrades unless required and approved.
- No success claim without verifiable evidence.
