# EQFAL — Tooling Recovery Playbook

## 1. Purpose

This file is the canonical source for tooling-failure classification and recovery in EQFAL.

Authority hierarchy:

`GitHub/main → AGENTS.md → docs/WORKFLOW_GOVERNANCE.md → docs/TOOLING_RECOVERY_PLAYBOOK.md → docs/EXECUTION_ROADMAP.md → TODO.md → Historical records`

If this playbook conflicts with a higher source, the higher source governs. A material unresolved ambiguity requires STOP + escalation.

## 2. Core Principle

**GitHub = durable project state. Codex session = disposable executor.**

A failed Codex session must never be treated as equivalent to a failed project. Recovery begins by determining what durable state actually exists on GitHub.

## 3. Failure Classification

### PROJECT FAILURE
A defect in the project itself, including code, approved design compliance, tests, security, tenancy, accounting/tax integrity, application behavior, schema, or other acceptance requirements.

Examples:
- CI fails because the code/test/build is wrong.
- implementation violates the approved Design Check.
- tenant isolation or permission enforcement is wrong.
- accounting logic is incorrect.

PROJECT FAILURE may use the single corrective implementation pass allowed by the Zero-Loop Rule.

### TOOLING FAILURE
A failure in execution/delivery infrastructure or session state while the project code has not been established as defective.

Examples:
- auth or connector failure;
- stale/missing checkout;
- broken Codex session;
- push or PR creation failure;
- CI infrastructure failure;
- credit/tool availability issue.

TOOLING FAILURE must not consume additional code-fix passes.

## 4. Durable Checkpoints vs Session-Local State

### DURABLE CHECKPOINT
State that exists independently of a disposable Codex session and can be re-read later from GitHub.

Examples:
- merged GitHub `main` commit;
- pushed branch/commit;
- open GitHub PR;
- GitHub CI evidence tied to a known SHA.

Durable state may be reused directly during recovery. Never rebuild it from scratch merely because a Codex session failed.

### SESSION-LOCAL / NON-DURABLE STATE
State that exists only inside a local/disposable execution session and is not independently recoverable from GitHub.

Examples:
- uncommitted Codex workspace changes;
- local-only commit not pushed anywhere;
- terminal output existing only in a session;
- Codex conversation/session state.

**Never assume session-local state is recoverable after session failure.**

If no durable checkpoint exists, do not claim the work is saved. A fresh implementation may be required later from the last verified durable baseline, subject to normal Design/One-Shot/credit controls.

## 5. Global Recovery Rule

For tooling incidents:

`Attempt 1 → classify → one tooling retry maximum → fresh Codex session from verified GitHub state → approved fallback / STOP`

Mandatory constraints:
- no infinite retry loops;
- no repeated reconnect/auth/push loops;
- no automatic purchase or consumption of paid credits beyond approved plan behavior;
- no automatic upgrade to a paid mode/service;
- no rebuilding a valid pushed commit/branch/PR from scratch;
- no Replit PR rescue or patch relay;
- no routine force-push/history rewrite;
- no assumption that session-local state survived a failed session.

## 6. Recovery Baseline Procedure

Before any fresh Codex recovery session:
1. Read current GitHub `main` HEAD directly.
2. Identify any existing durable checkpoint for the interrupted task.
3. Determine whether an open PR or pushed branch/commit already contains valid work.
4. If valid durable work exists, continue/review/deliver that work rather than reimplementing it.
5. If no durable work exists, start only from the verified approved GitHub baseline and approved task contract.
6. Do not infer state from stale local checkouts, branch names, or old conversation memory.

## 7. Incident Playbooks

### AUTH_FAILURE
**Class:** TOOLING FAILURE

Symptoms:
- required authentication unavailable;
- connector/session cannot perform an otherwise authorized operation.

Recovery:
1. Confirm GitHub itself and the intended repository state independently when possible.
2. Retry authentication/tool connection once.
3. If still failing, use a fresh Codex/session context with verified GitHub state.
4. If the required path remains unavailable, STOP and notify the user.

Do not repeatedly re-authenticate or alter credentials inside an implementation task without explicit approved need.

### REPO_CONNECTION_FAILURE
**Class:** TOOLING FAILURE

Symptoms:
- wrong/missing repository attachment;
- connector cannot reach the expected repository;
- repository identity cannot be verified.

Recovery:
1. Verify `Sydiha/eqfal` from the managing GitHub connection.
2. Retry the intended repository attachment once.
3. If still failing, start a fresh Codex task/session attached to verified repository state.
4. If identity remains unverifiable, STOP before modifying code.

### BASELINE_MISMATCH
**Class:** TOOLING / STATE FAILURE

Symptoms:
- Codex checkout HEAD does not equal the approved baseline SHA.

Recovery:
1. STOP before code changes.
2. Read current GitHub/main.
3. Decide whether the approved task baseline is still valid or the task requires a refreshed Design Check.
4. Use a clean/fresh checkout matching the approved baseline.

Do not silently reset to an arbitrary commit or continue on a stale baseline.

### DIRTY_WORKTREE
**Class:** TOOLING / STATE FAILURE

Symptoms:
- unexpected modified/staged/untracked files before implementation.

Recovery:
1. STOP before editing.
2. Do not delete/reset unknown work automatically.
3. Determine whether any dirty state is durable or merely session-local.
4. Prefer a fresh clean checkout from verified GitHub state.

### STALE_CHECKOUT
**Class:** TOOLING FAILURE

Symptoms:
- checkout is behind or otherwise not the intended approved baseline.

Recovery:
1. Do not implement from the stale checkout.
2. Retry checkout refresh once if the environment supports a safe verified path.
3. Otherwise discard the disposable checkout/session and create a fresh one from verified GitHub state.

### CANNOT_RESUME_TASK
**Class:** TOOLING FAILURE

Symptoms:
- Codex cannot resume an existing task/session.

Recovery:
1. Inspect GitHub for a durable checkpoint first.
2. If a valid PR/pushed commit exists, continue from that durable state rather than rebuilding.
3. If no durable checkpoint exists, acknowledge that session-local state may be lost.
4. Start a fresh Codex session from verified GitHub state using the approved contract.
5. If fresh execution is blocked by cost/tool availability, STOP.

### PUSH_FAILURE
**Class:** TOOLING FAILURE

Symptoms:
- implementation/tests may be complete, but a branch/commit cannot be pushed to GitHub through the approved path.

Recovery:
1. Determine whether any commit/branch is already durable on GitHub.
2. Retry the approved delivery mechanism once.
3. If still failing, use a fresh session/delivery context from the existing durable checkpoint if one exists.
4. If no durable checkpoint exists, do not claim the implementation is safely preserved.
5. Do not use Replit, manual patch replay, or routine force-push as rescue paths.

### PR_CREATION_FAILURE
**Class:** TOOLING FAILURE

Symptoms:
- pushed branch/commit exists but PR creation fails.

Recovery:
1. Preserve and reuse the pushed branch/commit.
2. Retry PR creation once using the approved GitHub/Codex path.
3. If still failing, use a fresh session or healthy GitHub PR creation path against the same durable branch.
4. Do not reimplement the feature from scratch.
5. If no approved path exists, STOP and notify the user.

### CI_INFRA_FAILURE
**Class:** TOOLING FAILURE

Symptoms:
- runner outage, dependency network failure, GitHub Actions infrastructure issue, or other failure not caused by project code.

Recovery:
1. Confirm the failure is infrastructure-related from logs/evidence tied to the SHA.
2. Re-run once.
3. If infrastructure fails again, STOP and defer until the infrastructure is healthy.

Do not alter product code to compensate for an infrastructure outage.

### CI_CODE_FAILURE
**Class:** PROJECT FAILURE

Symptoms:
- tests/typecheck/build fail because of the proposed code or approved acceptance requirements.

Recovery:
1. Review the actual failure against the approved Design Check.
2. Use the single allowed corrective programming pass when appropriate.
3. Re-run required validation/CI.
4. If a second corrective implementation pass would be required, STOP under the Zero-Loop Rule.

### CODEX_CREDIT_LIMIT
**Class:** TOOLING / COST FAILURE

Symptoms:
- task cannot continue because Codex allowance/credits are exhausted or additional paid usage is required.

Recovery:
1. STOP before any automatic purchase/upgrade.
2. Record the latest durable GitHub checkpoint.
3. Do not purchase extra credits automatically.
4. Resume later from the durable checkpoint when approved capacity is available.
5. If no durable checkpoint exists, state clearly that session-local work is not guaranteed recoverable.

### SESSION_FAILURE
**Class:** TOOLING FAILURE

Symptoms:
- session crashes, becomes unavailable, loses context, or cannot safely continue.

Recovery:
1. Inspect GitHub for durable checkpoints.
2. Never assume uncommitted/local-only work survived.
3. If durable work exists, continue from it in a fresh session.
4. Otherwise start from the last verified GitHub baseline using the approved implementation contract.
5. Do not repeatedly reopen/retry the broken session.

## 8. Valid Recovery Paths

Valid paths include:
- re-reading GitHub/main and current PR state;
- one bounded tooling retry;
- fresh Codex session attached to verified repository state;
- continuing from an existing pushed branch/commit/PR;
- one CI infrastructure rerun;
- stopping and notifying the user when no compliant path exists.

## 9. Prohibited Recovery Paths

Do not use:
- Replit Agent for coding, PR rescue, push, branch reconstruction, or GitHub writes;
- Copy patch / manual patch relay as a normal delivery mechanism;
- `git apply` reconstruction between tools;
- routine force-push/history rewriting;
- repeated auth/push/session loops;
- automatic paid-credit purchase or plan upgrade;
- reimplementation of valid durable work merely because a session failed;
- claims that local/session work is preserved without a durable checkpoint.

## 10. Credit / Cost Protection

- One tooling retry maximum before moving to a fresh verified session.
- No automatic additional paid credits.
- No Power/Max Replit mode as recovery.
- No new paid infrastructure/service as recovery without explicit user approval.
- When capacity is exhausted, prefer STOP + durable checkpoint preservation over repeated execution attempts.

## 11. Escalation Rules

STOP and notify the Lead PM/user when:
- repository identity or approved baseline cannot be verified;
- a required durable checkpoint is absent but the session is lost and the work cannot be proven preserved;
- the approved delivery path remains unavailable after bounded recovery;
- the recovery would require prohibited manual transfer, GitHub write from Replit, history rewriting, or paid capacity;
- project vs tooling classification remains materially ambiguous;
- a second corrective programming pass would be required.

## 12. Recovery Closeout Checklist

After successful recovery:
- identify the durable checkpoint used;
- verify repository and intended base SHA;
- verify the actual branch/PR/head SHA involved;
- verify CI evidence tied to the intended SHA when applicable;
- confirm no prohibited recovery path was used;
- confirm no automatic paid credits/service were used;
- confirm no valid durable work was unnecessarily rebuilt;
- return to the standard lifecycle in `docs/WORKFLOW_GOVERNANCE.md`.
