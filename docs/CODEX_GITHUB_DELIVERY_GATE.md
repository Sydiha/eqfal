# EQFAL — Codex Repository Access & GitHub Delivery Gates

Status: Active project guidance

This document separates two concerns that must not be confused:

1. **Repository Access / Execution Preflight** — required before Coding.
2. **GitHub Delivery / PR Handoff** — occurs after Coding and is not a condition for Coding success.

This file is subordinate to `AGENTS.md`, `docs/WORKFLOW_GOVERNANCE.md`, and `DEVELOPMENT_WORKFLOW.md`.

If a material conflict exists with higher-priority active governance: STOP and report it to the Project Owner.

## 1. Repository Access / Execution Preflight

Before Codex Cloud performs Product Coding, EQFAL must establish with evidence:

1. repository is exactly `Sydiha/eqfal`;
2. requested base/branch is correct;
3. approved baseline `HEAD SHA` is correct and recorded;
4. expected repository files can be read;
5. the required execution/test environment is usable for the task's basic validation.

A UI saying “connected” is not enough if repository identity or baseline cannot be verified.

If this preflight fails:

**STOP. Do not start Product Coding. Do not consume Codex Credit in random implementation retries.**

The availability of Create PR / Update PR is intentionally **not** part of this preflight.

## 2. Codex Cloud Role

Codex Cloud is a bounded Coding Engine only.

It may be invoked after:

`READ-ONLY → PLAN → OWNER APPROVAL → CODEX PREFLIGHT`

No autonomous or multi-agent workflow is permitted. There is no Orchestrator Agent, Builder Agent, Reviewer Agent, autonomous continuation, unattended execution, automatic task selection, or automatic merge.

EQFAL remains the sole coordinator.

## 3. Required Coding Task Contract

The Codex task must include at least:
- goal;
- approved baseline/SHA;
- expected files or scope;
- constraints;
- what must not be changed;
- required tests;
- acceptance criteria / success definition.

Codex must not expand scope or add unrelated refactors/dependency upgrades.

## 4. Codex Credit Conservation

Codex Credit is a project resource that must be conserved.

Rules:
- EQFAL performs diagnosis, inspection, planning, and task decomposition itself where reasonably possible;
- no unnecessary Codex exploration;
- no ambiguous Coding prompt;
- prefer one complete run where safe;
- do not rerun Coding because push, Create PR, Update PR, or other handoff failed;
- do not resend the same prompt before diagnosing the failure cause;
- every new Codex Cloud execution after the initial run, including a bounded correction inside the same scope, requires new explicit Owner Approval before execution;
- EQFAL may diagnose and prepare the correction plan without new approval, but there is no implicit approval and no automatic Codex correction loop;
- no unrelated refactor or side improvement;
- if multiple Codex rounds or materially high Credit use is reasonably expected, inform the Owner before Codex execution;
- no paid Credit/capacity increase without explicit Owner Approval.

## 5. GitHub Delivery / PR Handoff

After Coding, the preferred delivery path is:

`Codex result/commit → GitHub branch/commit → PR → CI`

Successful Coding does **not** depend on Codex itself successfully creating or updating a PR.

If Codex implemented the approved change successfully but push / Create PR / Update PR fails:

1. do not rerun the Coding task;
2. do not recreate valid work merely to repair handoff;
3. identify whether an implementation commit/result exists and whether any part is already durable on GitHub;
4. diagnose the handoff failure separately from code correctness;
5. preserve valid durable state;
6. use the lowest-cost compliant GitHub handoff path; manual handoff does not require new Owner Approval when it only transports the same already-approved implementation without changing code or scope, such as creating a branch, pushing the approved commit/result, creating a PR, updating the same PR with the same approved implementation, or adding non-implementation PR metadata;
7. if handoff requires code/implementation changes, a new Codex run, scope change, dependency addition, or behavior change, return to `OWNER APPROVAL` before Coding;
8. report to the Owner when Owner action or a material decision is otherwise needed.

Never state that a branch, commit, PR, or PR update exists until GitHub is independently verified.

## 6. GitHub Source-of-Truth Rule

`GitHub/main` is the Source of Truth for merged code and durable repository state.

GitHub PRs/branches/commits are delivery evidence only when independently readable from GitHub.

Session-local Codex state is not durable GitHub evidence.

## 7. SHA Delivery Chain

For practical validation, keep a clear chain where applicable:

`identifiable Codex result/commit → GitHub PR HEAD SHA → Replit validated SHA`

Before Owner UAT, it is mandatory to prove:

`GitHub PR HEAD SHA == Replit validated SHA`

If SHAs differ or cannot be proven: STOP and do not accept runtime validation.

## 8. Replit Boundary

Replit is Runtime / Practical Validation only.

It is not:
- Source of Truth;
- Product coding environment for an independent version;
- GitHub branch/PR rescue path;
- alternate durable delivery mechanism.

## 9. Delivery Acceptance

A task is not accepted merely because Codex reports success.

Acceptance evidence includes, as applicable:
- actual implementation result/diff;
- approved scope compliance;
- GitHub branch/PR state if handoff has occurred;
- exact PR HEAD SHA;
- appropriate tests/CI on the intended SHA;
- Replit same-SHA validation;
- Owner UAT;
- explicit Owner Merge Decision before merge.
