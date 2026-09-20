# EQFAL — Tooling Recovery Playbook

## 1. Purpose and Authority

This playbook defines bounded recovery for execution, GitHub handoff, CI infrastructure, Replit synchronization, and related tooling failures.

Operating precedence:

1. `AGENTS.md`
2. `docs/WORKFLOW_GOVERNANCE.md`
3. `DEVELOPMENT_WORKFLOW.md`
4. Specialized operational playbooks, including this file

Historical or superseded documents are not current execution authority.

If a material conflict exists: **STOP and report it to the Project Owner. Do not select an interpretation independently.**

## 2. Recovery Ownership

EQFAL is the sole workflow coordinator and recovery coordinator.

No autonomous or multi-agent workflow is used. There is no Orchestrator Agent, Builder Agent, Reviewer Agent, autonomous continuation, unattended execution, automatic task selection, or automatic merge.

Codex Cloud may be used only as the bounded Coding Engine under the approved workflow gates.

## 3. Core Recovery Principle

**Separate Product/code failure from tooling/handoff failure before spending another Codex run.**

`GitHub/main` is the Source of Truth for merged state. Durable GitHub evidence should be reused rather than rebuilt.

Codex Credit must be conserved.

## 4. Failure Classes

### PRODUCT / CODE FAILURE

A defect in implementation, approved scope, tests, security, tenancy, accounting/tax behavior, schema, application behavior, or another acceptance requirement.

Examples:
- CI fails because the code is wrong;
- implementation violates the Owner-approved plan;
- tenant isolation or permission enforcement is wrong;
- application behavior fails acceptance criteria.

A Product/code failure may require a bounded Codex correction. EQFAL may diagnose the failure and prepare a bounded correction plan without new approval. **Before any new Codex Cloud execution, including a correction inside the same approved scope, new explicit Owner Approval is required.** There is no implicit approval and no automatic Codex correction loop.

### TOOLING / HANDOFF FAILURE

A failure in repository connection, Codex environment, session state, push/PR handoff, CI infrastructure, Replit synchronization, or tool availability while Product code has not been established as defective.

Examples:
- repository attachment failure before Coding;
- Codex session failure;
- push failure;
- Create PR / Update PR failure;
- GitHub connector failure;
- CI infrastructure outage;
- Replit sync failure;
- Credit/capacity issue.

A tooling/handoff failure is **not** authorization to rerun Coding automatically.

## 5. Repository Access / Execution Preflight Failure

Before Coding, Codex preflight must prove:
- repository `Sydiha/eqfal`;
- correct base/branch;
- correct approved baseline HEAD SHA;
- required repository files readable;
- required execution/test environment usable.

If any of these cannot be verified: **STOP before Coding.**

Do not start implementation and do not consume Credit in repeated Coding attempts while preflight is unresolved.

## 6. Coding Succeeds but GitHub Handoff Fails

This is a separate recovery path.

If approved Coding was completed but push / Create PR / Update PR fails:

1. do not rerun Coding;
2. do not resend the same Coding prompt;
3. identify the latest implementation result/commit and any durable GitHub checkpoint;
4. determine exactly which handoff step failed;
5. preserve valid durable GitHub work;
6. repair or route the handoff using the lowest-cost compliant method;
7. report to the Owner if Owner action, a material risk, or a new cost is required.

Never reimplement correct code merely because delivery failed.

## 7. Codex Credit Recovery Rules

- Codex Credit is a constrained resource.
- EQFAL performs diagnosis before any rerun.
- No unnecessary Codex exploration.
- No same-prompt rerun without a diagnosed reason.
- Every new Codex Cloud execution after the initial run requires new explicit Owner Approval before execution, including bounded corrections inside the same scope.
- No Coding rerun for push/PR/handoff-only failure.
- No unrelated refactor or cleanup during recovery.
- No automatic Credit purchase or paid-capacity upgrade.
- If multiple Codex rounds or materially high Credit use is reasonably expected, inform the Owner before continuing.

## 8. Durable vs Session-Local State

### Durable evidence
Examples:
- merged `main` commit;
- pushed branch/commit;
- actual GitHub PR;
- GitHub CI result tied to a known SHA.

Reuse valid durable state. Do not rebuild it because an execution session failed.

### Session-local evidence
Examples:
- uncommitted workspace changes;
- local-only commit not visible through an approved durable handoff;
- terminal output existing only in a Codex session;
- Codex conversation/session state.

Do not represent session-local state as durable GitHub evidence.

## 9. Incident Procedures

### REPOSITORY_CONNECTION_FAILURE
1. STOP before Product Coding.
2. Verify `Sydiha/eqfal` independently.
3. Verify requested base/branch and approved baseline SHA.
4. Re-establish a usable execution environment without starting Coding retries.
5. If still unresolved, report the blocker to the Owner.

### BASELINE_MISMATCH
1. STOP before Coding.
2. Read current GitHub state and the Owner-approved baseline.
3. Determine whether the approved plan is still valid.
4. If the plan must materially change, return to `PLAN → OWNER APPROVAL`.

Never silently continue from a stale or arbitrary baseline.

### CODEX_SESSION_FAILURE DURING IMPLEMENTATION
1. Determine whether any implementation result exists.
2. Determine whether any result is durable on GitHub.
3. Diagnose whether Product code is defective or the session/tool failed.
4. Do not blindly resend the same prompt.
5. If a new Codex run is required, prepare it as a bounded task, then STOP at `OWNER APPROVAL`; explicit Owner Approval is required before the new Codex execution even when it remains inside the same scope.

### PUSH_FAILURE / PR_CREATION_FAILURE / PR_UPDATE_FAILURE
1. Treat as GitHub handoff failure, not code failure.
2. Do not rerun Coding.
3. Reuse any valid commit/branch already durable on GitHub.
4. Diagnose the exact delivery failure.
5. Use the lowest-cost compliant handoff path. Manual GitHub handoff does not require new Owner Approval when it only transports the same already-approved implementation without changing code or scope (branch creation, pushing the approved result, PR creation/update, or non-implementation PR metadata).
6. If handoff requires code/implementation changes, a new Codex run, scope change, dependency addition, or behavior change, return to `OWNER APPROVAL` before Coding.
7. If no compliant path remains or other Owner action is needed, STOP and report.

### CI_INFRA_FAILURE
1. Confirm the failure is infrastructure/tooling rather than code.
2. Preserve the exact intended SHA.
3. Use a bounded infrastructure rerun when appropriate.
4. Do not modify Product code to compensate for an infrastructure outage.
5. If infrastructure remains unhealthy, STOP/defer.

### CI_CODE_FAILURE
1. Diagnose the failure against the approved plan.
2. Determine whether a bounded correction can be prepared inside the approved plan.
3. Prepare a precise correction task rather than a broad rerun.
4. Return to `OWNER APPROVAL` before any new Codex Cloud execution, even when the correction remains inside the same scope.
5. If scope/plan must change or multiple/high-Credit rounds are expected, state that explicitly to the Owner before approval.

### CODEX_CREDIT_LIMIT / PAID_CAPACITY_REQUIRED
1. STOP before purchase or upgrade.
2. Preserve the latest durable GitHub state.
3. Do not buy Credits or switch to paid capacity automatically.
4. Use an already-approved no-new-cost path only when suitable.
5. Otherwise report the decision/cost to the Owner.

### REPLIT_SYNC_OR_SHA_FAILURE
1. Replit remains Runtime / Practical Validation only.
2. Replit Agent is prohibited for recovery, sync, startup, validation, Git, or any other action. Use manual **Replit Shell only** for approved Replit commands.
3. Verify GitHub PR HEAD SHA.
4. Verify the SHA actually being validated in Replit.
5. If they differ or cannot be proven, STOP validation.
6. Do not use Replit to recreate, push, or rescue Product changes.

### EXCEPTIONAL_GIT_RECOVERY
Force-push, history rewrite, destructive Git recovery, or equivalent exceptional action requires explicit Owner Approval.

STOP normal recovery, preserve known durable state, present the exact recovery plan and risk, and wait for Owner Approval.

## 10. Prohibited Recovery Patterns

Do not:
- use an autonomous or multi-agent recovery chain;
- rerun Product Coding because push/PR handoff failed;
- resend the same Codex prompt without diagnosing the cause;
- enter repeated reconnect/auth/push/Codex loops;
- use Replit as Git delivery or PR rescue;
- perform unrelated refactors during recovery;
- upgrade dependencies merely to simplify tooling recovery;
- buy Credits or paid capacity automatically;
- use automatic merge;
- claim a branch/commit/PR/test/CI/sync/validation exists or passed without evidence.

## 11. Return to Workflow

After recovery, return to the exact gate where the failure occurred. Do not skip later gates.

Before Owner UAT, SHA integrity must be proven:

`GitHub PR HEAD SHA == Replit validated SHA`

When an identifiable Codex result/commit exists, maintain traceability through the same delivery chain.

Only the Owner performs final UAT and makes the final Merge Decision.
