# EQFAL Workflow Governance

This document defines the detailed current operating lifecycle for EQFAL. It is subordinate to `AGENTS.md` and must remain consistent with it.

## 1. Document Precedence

Current operating authority is:

1. `AGENTS.md`
2. `docs/WORKFLOW_GOVERNANCE.md`
3. `DEVELOPMENT_WORKFLOW.md`
4. Specialized operational playbooks

`GitHub/main` is the source of truth for merged repository state.

Historical or superseded documents are records only and are not active execution instructions.

If current instructions materially conflict: **STOP and report the conflict to the Project Owner. Do not resolve it by choosing an interpretation independently.**

## 2. Operating Model

EQFAL uses an Owner-controlled, single-coordinator model.

### Project Owner

The Owner:
- approves the plan before Product coding;
- performs final UAT;
- alone makes the Merge Decision;
- approves any Production change or new paid cost.

Approval must be explicit. Silence is not approval.

### EQFAL

EQFAL is the sole workflow coordinator. It performs Read-only inspection, diagnosis, planning, Codex task preparation, post-Codex review, test/CI verification, GitHub verification, Replit same-SHA verification, and UAT preparation.

### Codex Cloud

Codex Cloud is a bounded Coding Engine used only after Owner Approval and successful Codex preflight. It has no roadmap, approval, review, merge, Production, or cost authority.

## 3. No Agents

The rule means **no autonomous or multi-agent workflow**.

Prohibited operating roles or behaviors include:
- Orchestrator Agent;
- Builder Agent;
- Reviewer Agent / Independent Reviewer Agent;
- autonomous continuation;
- unattended execution;
- automatic task selection;
- automatic merge.

This does not prohibit Codex Cloud. Codex Cloud is permitted only as the Coding Engine inside the gated workflow, with EQFAL as the sole coordinator.

## 4. Official Workflow Gates

Every Product task must pass these gates in order:

1. `READ-ONLY`
2. `PLAN`
3. `OWNER APPROVAL`
4. `CODEX PREFLIGHT`
5. `CODEX EXECUTION`
6. `EQFAL REVIEW`
7. `TESTS / CI`
8. `GITHUB HANDOFF`
9. `REPLIT SAME-SHA VALIDATION`
10. `OWNER UAT`
11. `OWNER MERGE DECISION`

No gate may be bypassed. A material failure blocks progression.

## 5. Gate 1 — READ-ONLY

Before proposing implementation, EQFAL inspects current authoritative state without modifying Product files.

Required outputs as applicable:
- repository identity;
- current `GitHub/main` HEAD SHA;
- current relevant implementation;
- directly relevant governance/roadmap constraints;
- gaps and blockers;
- likely affected files/boundaries;
- risks and testing needs.

EQFAL should use repository inspection itself rather than Codex exploration when reasonably possible.

## 6. Gate 2 — PLAN

EQFAL prepares a bounded implementation plan containing:
- baseline SHA;
- goal;
- expected scope/files;
- out-of-scope items;
- constraints / protected areas;
- schema/migrations if relevant;
- test/CI plan;
- risks;
- acceptance criteria;
- expected Codex Credit risk, especially if multiple runs may be required.

No Coding occurs during this gate.

## 7. Gate 3 — OWNER APPROVAL

The plan is submitted to the Owner.

Coding may start only after explicit Owner Approval.

Not valid approval:
- silence;
- lack of objection;
- previous approval of a roadmap or another task;
- automated continuation;
- an internal EQFAL decision.

A materially changed plan requires renewed Owner Approval before Coding.

## 8. Gate 4 — CODEX PREFLIGHT

This is **Repository Access / Execution Preflight**, not GitHub Delivery/PR Handoff.

Before Product Coding, verify:
- repository = `Sydiha/eqfal`;
- correct base/branch selection;
- correct approved baseline `HEAD SHA`;
- repository files required by the task are readable;
- required execution/test environment is usable for basic task validation.

A UI label such as “connected” is not sufficient if repository identity or baseline cannot be independently established.

If this preflight fails: **STOP. Do not start Coding and do not perform random Coding retries.**

The ability to Create PR or Update PR is not part of this preflight and is not required for Coding success.

## 9. Gate 5 — CODEX EXECUTION

After Owner Approval and successful preflight, EQFAL sends Codex one complete coding task containing:
- goal;
- approved baseline/SHA;
- expected scope/files;
- constraints;
- explicit protected/out-of-scope items;
- required tests;
- acceptance criteria.

Codex execution must remain bounded to the approved task.

### Codex Credit Rules

Codex Credit is a constrained resource.

- EQFAL diagnoses and plans itself where possible.
- No unnecessary Codex exploration.
- No ambiguous or incomplete Coding task.
- Prefer one coherent run where logically related work can be safely combined.
- No rerun because push/PR/handoff failed.
- No repeat of the same prompt without diagnosing the prior failure.
- Every new Codex Cloud execution after the initial run, including a bounded correction inside the same approved scope, requires a new explicit Owner Approval before execution.
- EQFAL may diagnose and prepare a bounded correction plan without new approval, but there is no implicit approval and no automatic Codex correction loop.
- No unrelated refactor or dependency upgrade.
- Inform the Owner before starting when multiple Codex rounds or materially high Credit usage is reasonably expected.
- No paid Credit/capacity increase without explicit Owner Approval.

## 10. Gate 6 — EQFAL REVIEW

EQFAL reviews the actual implementation and diff against the approved plan.

Review includes as applicable:
- changed files and exact scope;
- acceptance criteria;
- accounting/tax correctness;
- tenant isolation;
- permission/capability enforcement;
- auditability;
- schema/migrations;
- regression risk;
- unauthorized refactors, dependencies, infrastructure, cost, or Production changes.

A Codex summary is not acceptance evidence.

If implementation materially deviates from the approved plan: STOP. EQFAL may diagnose and prepare a bounded correction plan without new approval, but before any new Codex Cloud execution the workflow returns to `OWNER APPROVAL`, even when the correction remains inside the same scope.

## 11. Gate 7 — TESTS / CI

Run and verify the tests appropriate to the task, which may include:
- targeted tests;
- typecheck;
- lint when part of the repository's applicable checks;
- build;
- GitHub CI tied to the exact intended commit/PR SHA.

Do not proceed while a P1 related to the change remains unresolved or relevant CI is failing.

CI infrastructure failure and code failure must be distinguished before deciding the next action.

## 12. Gate 8 — GITHUB HANDOFF

GitHub delivery is a separate stage from Coding execution.

Ideal path:

`Codex result/commit → branch/commit → GitHub PR → CI`

A Coding task may be technically successful even if Codex cannot push, Create PR, or Update PR.

If Coding succeeded and handoff fails:
- do not rerun Coding;
- do not rebuild valid work merely to repair handoff;
- identify the latest usable or durable result;
- diagnose the handoff problem separately;
- use the lowest-cost compliant delivery path when needed;
- manual GitHub handoff does not require new Owner Approval when it only transports the same already-approved implementation without changing code or scope, including branch creation, pushing the approved commit/result, PR creation/update, or non-implementation PR metadata;
- if handoff requires code/implementation changes, a new Codex run, scope change, dependency addition, or behavior change, return to `OWNER APPROVAL` before Coding;
- notify the Owner when Owner action/decision is otherwise required.

A PR is not considered created or updated until GitHub confirms it.

## 13. Gate 9 — REPLIT SAME-SHA VALIDATION

Replit is Runtime / Practical Validation only.

It is not:
- Source of Truth;
- an independent Product-development branch;
- a GitHub delivery bridge;
- a PR recovery path.

Before Owner UAT, prove:

`GitHub PR HEAD SHA == SHA validated in Replit`

When an identifiable Codex commit/result exists, it must be traceable into the same delivery chain.

If the GitHub PR HEAD SHA and Replit validation SHA differ, or the SHA cannot be proven: **STOP.** Runtime validation is not accepted.

## 14. Gate 10 — OWNER UAT

EQFAL prepares a specific UAT checklist for the Owner.

For each test step include:
- where to navigate;
- what to click;
- what data to enter;
- what should appear;
- expected result;
- important negative/edge case where relevant.

The Owner performs final UAT. EQFAL must not replace Owner UAT with a generic statement that the system was tested.

## 15. Gate 11 — OWNER MERGE DECISION

Only the Owner decides whether to merge.

No automatic merge is permitted.

Owner Approval of the Coding plan is not approval to merge. UAT completion is not implicit merge approval. Silence is not approval.

The final state before merge decision must show, as applicable:
- approved task lineage;
- actual GitHub PR/diff;
- exact PR HEAD SHA;
- EQFAL review result;
- required tests/CI result;
- Replit same-SHA validation result;
- Owner UAT result;
- unresolved blockers, if any.

## 16. Failure and STOP Rules

STOP when:
- repository identity or approved baseline cannot be verified;
- active governance instructions materially conflict;
- Owner Approval has not been explicitly given before Coding;
- Codex preflight fails;
- continuing requires scope expansion not approved by the Owner;
- required code/test/CI blockers remain unresolved;
- same-SHA validation cannot be proven;
- Production, paid cost, destructive real-data, secrets/credentials, sensitive real-user permission, or exceptional Git recovery action requires Owner Approval that has not been given;
- Owner Merge Decision has not been explicitly given.

## 17. Cost and Scope Boundaries

Permanent rules:
- one task at a time;
- no autonomous or multi-agent workflow;
- no new paid service/API/infrastructure/credits/plan without explicit Owner Approval;
- no Production changes without explicit Owner Approval;
- no scope expansion;
- no unrelated refactor;
- no dependency upgrade unless required by the approved task and appropriately approved;
- no automatic merge;
- no success claim without verifiable evidence.

## 18. Closeout

After the Owner explicitly approves merge and the merge is actually performed through an approved path, verify the new `GitHub/main` HEAD and record only facts that are independently verifiable.

Do not automatically start the next Product task. The next task begins again at `READ-ONLY` and follows the same Owner-controlled gates.
